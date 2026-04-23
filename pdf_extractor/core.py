"""
PDF文本提取模块 - 核心层 (core.py)

提供PDF文本提取的主逻辑编排，包括：
- 提取策略降级链（pdfplumber → PyPDF2 → OCR）
- 缓存机制支持
- 并行处理多页PDF
- 大文件分页处理
- 加密PDF和损坏PDF的优雅处理

主要类:
    PDFTextExtractor: 主提取编排器，协调多种提取策略

示例:
    >>> extractor = PDFTextExtractor()
    >>> result = extractor.extract(pdf_data, use_ocr=True)
    >>> print(result["text"])
"""

import io
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple, Union

# 模块日志器
logger = logging.getLogger(__name__)

# 从utils导入工具类和函数
from .utils import (
    PDFExtractorConfig,
    ExtractionCache,
    calculate_hash,
    normalize_pdf_input,
    format_extraction_result,
    assess_extraction_quality,
)

# 从ocr_handler导入OCR处理器
from .ocr_handler import OCRHandler

# 可选依赖导入（优雅降级）
try:
    import pdfplumber
    PDFPLUMBER_AVAILABLE = True
except ImportError:
    PDFPLUMBER_AVAILABLE = False
    logger.warning("pdfplumber未安装，该提取策略将不可用")

try:
    from PyPDF2 import PdfReader
    PYPDF2_AVAILABLE = True
except ImportError:
    PYPDF2_AVAILABLE = False
    logger.warning("PyPDF2未安装，该提取策略将不可用")


class PDFTextExtractor:
    """PDF文本提取主类，负责编排整个提取流程。

    该类实现了提取策略降级链：pdfplumber → PyPDF2 → OCR，
    支持缓存、并行处理和大文件分页。

    Attributes:
        config: 配置管理器实例
        cache: 缓存管理器实例
        ocr_handler: OCR处理器实例
        enable_parallel: 是否启用并行处理

    Example:
        >>> extractor = PDFTextExtractor({"performance": {"cache_results": True}})
        >>> result = extractor.extract(pdf_bytes, max_pages=10)
        >>> print(f"提取方法: {result['method']}, 页数: {result['page_count']}")
    """

    # 默认配置
    DEFAULT_MAX_PAGES = 50
    DEFAULT_PARALLEL_WORKERS = 4
    MIN_TEXT_LENGTH_FOR_VALID = 10  # 有效文本的最小长度

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        """初始化PDF文本提取器。

        Args:
            config: 配置字典，用于覆盖默认配置。支持以下配置项：
                - performance.cache_results: 是否启用缓存（默认True）
                - performance.max_pages: 默认最大处理页数（默认50）
                - performance.use_async: 是否启用并行处理（默认True）
                - ocr.enabled: 是否启用OCR（默认True）
                - ocr.language: OCR语言列表

        Example:
            >>> config = {"performance": {"max_pages": 100, "use_async": False}}
            >>> extractor = PDFTextExtractor(config)
        """
        # 初始化配置
        self._config = PDFExtractorConfig(config)

        # 初始化缓存
        cache_enabled = self._config.get("performance.cache_results", True)
        cache_size = 256 if cache_enabled else 0
        self._cache = ExtractionCache(max_size=cache_size)

        # 初始化OCR处理器
        self._ocr_handler = OCRHandler(config)

        # 并行处理配置
        self._enable_parallel = self._config.get("performance.use_async", True)
        self._parallel_workers = self.DEFAULT_PARALLEL_WORKERS

        logger.debug(
            "PDFTextExtractor初始化完成: cache=%s, parallel=%s",
            cache_enabled, self._enable_parallel
        )

    def extract(
        self,
        pdf_data: Union[bytes, str],
        use_ocr: bool = False,
        ocr_languages: List[str] = None,
        max_pages: int = None
    ) -> Dict[str, Any]:
        """主提取方法，执行完整的PDF文本提取流程。

        该方法执行以下步骤：
        1. 规范化输入数据（支持bytes或base64字符串）
        2. 检查缓存
        3. 执行提取策略链
        4. 格式化输出结果
        5. 存入缓存

        Args:
            pdf_data: PDF原始数据，支持bytes或base64编码字符串
            use_ocr: 是否启用OCR作为降级策略（默认False）
            ocr_languages: OCR语言列表，如["eng", "chi_sim"]（默认["eng"]）
            max_pages: 最大处理页数（默认使用配置值，通常为50）

        Returns:
            统一格式的提取结果字典，包含以下键：
            - success: bool, 提取是否成功
            - text: str, 提取的文本内容
            - metadata: Dict, 提取元数据
            - page_count: int, PDF总页数
            - pages_processed: int, 实际处理的页数
            - used_ocr: bool, 是否使用了OCR
            - method: str, 实际使用的提取方法
            - error: Optional[str], 错误信息
            - truncated: bool, 是否被截断

        Example:
            >>> extractor = PDFTextExtractor()
            >>> result = extractor.extract(pdf_bytes, use_ocr=True, max_pages=10)
            >>> if result["success"]:
            ...     print(f"提取成功，共{result['page_count']}页")
            ... else:
            ...     print(f"提取失败: {result['error']}")
        """
        start_time = time.time()

        # 使用默认配置值
        if max_pages is None:
            max_pages = self._config.get("performance.max_pages", self.DEFAULT_MAX_PAGES)

        if ocr_languages is None:
            ocr_languages = ["eng"]

        try:
            # 1. 规范化输入数据
            pdf_bytes = normalize_pdf_input(pdf_data)

            # 2. 计算哈希用于缓存
            hash_key = calculate_hash(pdf_bytes)

            # 3. 检查缓存
            cached_result = self._check_cache(hash_key)
            if cached_result:
                logger.info("缓存命中，直接返回缓存结果")
                return cached_result

            # 4. 检查文件大小限制
            max_file_size_mb = self._config.get("performance.max_file_size_mb", 50)
            file_size_mb = len(pdf_bytes) / (1024 * 1024)
            if file_size_mb > max_file_size_mb:
                error_msg = f"PDF文件过大({file_size_mb:.1f}MB)，超过限制({max_file_size_mb}MB)"
                logger.warning(error_msg)
                return self._create_error_result(error_msg)

            # 5. 执行提取策略链
            result = self._run_extraction_chain(
                pdf_bytes, max_pages, use_ocr, ocr_languages
            )

            # 6. 计算耗时
            elapsed_ms = int((time.time() - start_time) * 1000)

            # 7. 格式化结果
            formatted_result = self._format_result(result, elapsed_ms)

            # 8. 存入缓存
            if formatted_result.get("success"):
                self._store_cache(hash_key, formatted_result)

            return formatted_result

        except Exception as e:
            error_msg = f"提取过程发生错误: {type(e).__name__}: {e}"
            logger.exception(error_msg)
            return self._create_error_result(error_msg)

    def extract_with_pdfplumber(
        self,
        pdf_data: bytes,
        max_pages: int
    ) -> Dict[str, Any]:
        """使用pdfplumber提取PDF文本。

        pdfplumber是首选提取策略，对表格和复杂布局的PDF提取效果最好。

        Args:
            pdf_data: PDF文件字节数据
            max_pages: 最大处理页数

        Returns:
            提取结果字典，格式与extract方法一致

        Example:
            >>> result = extractor.extract_with_pdfplumber(pdf_bytes, max_pages=10)
            >>> if result["success"]:
            ...     print(f"pdfplumber提取成功: {len(result['text'])}字符")
        """
        if not PDFPLUMBER_AVAILABLE:
            error_msg = "pdfplumber库未安装"
            logger.warning(error_msg)
            return self._create_error_result(error_msg)

        try:
            with pdfplumber.open(io.BytesIO(pdf_data)) as pdf:
                total_pages = len(pdf.pages)
                pages_to_process = min(total_pages, max_pages)

                texts = []
                for i in range(pages_to_process):
                    try:
                        page = pdf.pages[i]
                        text = page.extract_text()
                        if text:
                            texts.append(f"--- Page {i + 1} ---\n{text}")
                    except Exception as e:
                        logger.warning(f"pdfplumber提取第{i+1}页时出错: {e}")
                        continue

                full_text = "\n\n".join(texts)

                return {
                    "success": bool(full_text.strip()),
                    "text": full_text,
                    "page_count": total_pages,
                    "pages_processed": pages_to_process,
                    "used_ocr": False,
                    "method": "pdfplumber",
                    "error": None,
                    "truncated": total_pages > max_pages,
                }

        except Exception as e:
            error_msg = f"pdfplumber提取失败: {type(e).__name__}: {e}"
            logger.warning(error_msg)
            return self._create_error_result(error_msg)

    def extract_with_pypdf2(
        self,
        pdf_data: bytes,
        max_pages: int
    ) -> Dict[str, Any]:
        """使用PyPDF2提取PDF文本。

        PyPDF2作为备选策略，在pdfplumber失败时使用。纯Python实现，
        无系统依赖，兼容性较好。

        Args:
            pdf_data: PDF文件字节数据
            max_pages: 最大处理页数

        Returns:
            提取结果字典，格式与extract方法一致

        Example:
            >>> result = extractor.extract_with_pypdf2(pdf_bytes, max_pages=10)
            >>> if result["success"]:
            ...     print(f"PyPDF2提取成功: {len(result['text'])}字符")
        """
        if not PYPDF2_AVAILABLE:
            error_msg = "PyPDF2库未安装"
            logger.warning(error_msg)
            return self._create_error_result(error_msg)

        try:
            reader = PdfReader(io.BytesIO(pdf_data))
            total_pages = len(reader.pages)
            pages_to_process = min(total_pages, max_pages)

            texts = []
            for i in range(pages_to_process):
                try:
                    page = reader.pages[i]
                    text = page.extract_text()
                    if text:
                        texts.append(f"--- Page {i + 1} ---\n{text}")
                except Exception as e:
                    logger.warning(f"PyPDF2提取第{i+1}页时出错: {e}")
                    continue

            full_text = "\n\n".join(texts)

            return {
                "success": bool(full_text.strip()),
                "text": full_text,
                "page_count": total_pages,
                "pages_processed": pages_to_process,
                "used_ocr": False,
                "method": "pypdf2",
                "error": None,
                "truncated": total_pages > max_pages,
            }

        except Exception as e:
            error_msg = f"PyPDF2提取失败: {type(e).__name__}: {e}"
            logger.warning(error_msg)
            return self._create_error_result(error_msg)

    def extract_with_ocr(
        self,
        pdf_data: bytes,
        max_pages: int,
        ocr_languages: List[str]
    ) -> Dict[str, Any]:
        """使用OCR提取PDF文本。

        OCR作为最终降级策略，用于处理扫描件或图片型PDF。
        需要系统安装tesseract和poppler依赖。

        Args:
            pdf_data: PDF文件字节数据
            max_pages: 最大处理页数
            ocr_languages: OCR语言列表，如["eng", "chi_sim"]

        Returns:
            提取结果字典，格式与extract方法一致

        Example:
            >>> result = extractor.extract_with_ocr(pdf_bytes, 10, ["eng", "chi_sim"])
            >>> if result["success"]:
            ...     print(f"OCR提取成功: {len(result['text'])}字符")
        """
        if not self._ocr_handler.is_available():
            error_msg = "OCR依赖不可用（需要安装tesseract和poppler）"
            logger.warning(error_msg)
            return self._create_error_result(error_msg)

        try:
            result = self._ocr_handler.extract_text(
                pdf_data,
                max_pages=max_pages,
                ocr_languages=ocr_languages
            )
            return result

        except Exception as e:
            error_msg = f"OCR提取失败: {type(e).__name__}: {e}"
            logger.warning(error_msg)
            return self._create_error_result(error_msg)

    def _run_extraction_chain(
        self,
        pdf_data: bytes,
        max_pages: int,
        use_ocr: bool,
        ocr_languages: List[str]
    ) -> Dict[str, Any]:
        """执行提取策略降级链。

        降级顺序：pdfplumber → PyPDF2 → OCR
        每次降级都会记录日志。

        Args:
            pdf_data: PDF文件字节数据
            max_pages: 最大处理页数
            use_ocr: 是否启用OCR
            ocr_languages: OCR语言列表

        Returns:
            提取结果字典
        """
        # 策略1: pdfplumber（首选）
        logger.info("尝试使用pdfplumber提取...")
        result = self.extract_with_pdfplumber(pdf_data, max_pages)

        if result["success"] and self._is_text_valid(result["text"]):
            logger.info("pdfplumber提取成功")
            return result

        logger.warning("pdfplumber提取失败或结果无效，降级到PyPDF2")

        # 策略2: PyPDF2（备选）
        logger.info("尝试使用PyPDF2提取...")
        result = self.extract_with_pypdf2(pdf_data, max_pages)

        if result["success"] and self._is_text_valid(result["text"]):
            logger.info("PyPDF2提取成功")
            return result

        logger.warning("PyPDF2提取失败或结果无效")

        # 策略3: OCR（降级）
        if use_ocr:
            logger.info("尝试使用OCR提取...")
            result = self.extract_with_ocr(pdf_data, max_pages, ocr_languages)

            if result["success"] and self._is_text_valid(result["text"]):
                logger.info("OCR提取成功")
                return result

            logger.warning("OCR提取失败或结果无效")
        else:
            logger.info("OCR未启用，跳过OCR策略")

        # 所有策略都失败
        error_msg = "所有提取策略均失败"
        logger.error(error_msg)
        return self._create_error_result(error_msg)

    def _is_text_valid(self, text: str) -> bool:
        """检查提取的文本是否有效。

        文本有效性判断标准：
        - 去除空白字符后长度大于MIN_TEXT_LENGTH_FOR_VALID
        - 文本非全为特殊字符或乱码

        Args:
            text: 提取的文本

        Returns:
            True如果文本有效，False否则
        """
        if not text:
            return False

        # 去除空白字符
        cleaned = text.strip()
        if len(cleaned) < self.MIN_TEXT_LENGTH_FOR_VALID:
            return False

        # 检查是否包含足够的可打印字符
        printable_chars = sum(1 for c in cleaned if c.isprintable())
        if printable_chars / len(cleaned) < 0.5:
            return False

        return True

    def _check_cache(self, hash_key: str) -> Optional[Dict[str, Any]]:
        """检查缓存中是否存在结果。

        Args:
            hash_key: 缓存键（SHA256哈希）

        Returns:
            缓存的结果字典，未命中返回None
        """
        return self._cache.get(hash_key)

    def _store_cache(self, hash_key: str, result: Dict[str, Any]) -> None:
        """将结果存入缓存。

        Args:
            hash_key: 缓存键（SHA256哈希）
            result: 提取结果字典
        """
        self._cache.put(hash_key, result)

    def _extract_parallel(
        self,
        pdf_data: bytes,
        page_count: int,
        extract_func,
        max_workers: int = None
    ) -> str:
        """并行提取多页PDF文本。

        使用ThreadPoolExecutor实现多页并行提取，提高处理速度。

        Args:
            pdf_data: PDF文件字节数据
            page_count: 总页数
            extract_func: 单页提取函数
            max_workers: 最大并行工作线程数

        Returns:
            合并后的完整文本
        """
        if max_workers is None:
            max_workers = self._parallel_workers

        if not self._enable_parallel or page_count <= 1:
            # 不启用并行或只有一页，使用顺序处理
            return extract_func(pdf_data)

        texts = [""] * page_count

        def extract_page(page_num: int) -> Tuple[int, str]:
            """提取单页文本。"""
            try:
                text = extract_func(pdf_data, page_num)
                return page_num, text
            except Exception as e:
                logger.warning(f"第{page_num+1}页并行提取失败: {e}")
                return page_num, ""

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(extract_page, i): i
                for i in range(page_count)
            }

            for future in as_completed(futures):
                page_num, text = future.result()
                texts[page_num] = text

        # 按页码顺序合并文本
        return "\n\n".join(
            f"--- Page {i + 1} ---\n{text}"
            for i, text in enumerate(texts)
            if text.strip()
        )

    def _create_error_result(self, error_msg: str) -> Dict[str, Any]:
        """创建错误结果字典。

        Args:
            error_msg: 错误信息

        Returns:
            格式化的错误结果字典
        """
        return {
            "success": False,
            "text": "",
            "metadata": {},
            "page_count": 0,
            "pages_processed": 0,
            "used_ocr": False,
            "method": "none",
            "error": error_msg,
            "truncated": False,
        }

    def _format_result(
        self,
        result: Dict[str, Any],
        elapsed_ms: int
    ) -> Dict[str, Any]:
        """格式化提取结果为统一输出格式。

        Args:
            result: 原始提取结果
            elapsed_ms: 提取耗时（毫秒）

        Returns:
            格式化后的结果字典
        """
        if not result.get("success"):
            return result

        # 添加元数据
        result["metadata"] = {
            "extraction_time_ms": elapsed_ms,
            "quality_indicators": assess_extraction_quality(
                result.get("text", ""),
                page_count=result.get("page_count", 0),
                method_used=result.get("method", "unknown"),
            ),
        }

        return result

    def get_cache_stats(self) -> Dict[str, Any]:
        """获取缓存统计信息。

        Returns:
            缓存统计信息字典
        """
        return {
            "cache_size": self._cache.size,
            "cache_max_size": self._cache._max_size,
            "cache_enabled": self._cache._max_size > 0,
        }

    def clear_cache(self) -> None:
        """清空缓存。"""
        self._cache.clear()
        logger.info("缓存已清空")

    def get_status(self) -> Dict[str, Any]:
        """获取提取器状态信息。

        Returns:
            包含提取器状态的字典
        """
        return {
            "pdfplumber_available": PDFPLUMBER_AVAILABLE,
            "pypdf2_available": PYPDF2_AVAILABLE,
            "ocr_available": self._ocr_handler.is_available(),
            "parallel_enabled": self._enable_parallel,
            "cache_stats": self.get_cache_stats(),
            "config": self._config.to_dict(),
        }
