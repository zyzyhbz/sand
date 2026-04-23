"""
PDF文本提取模块 - OCR处理层 (ocr_handler.py)

提供PDF扫描件/图片型PDF的OCR文本提取功能，包括：
- PDF页面转换为图像（使用pdf2image）
- OCR文本识别（使用pytesseract）
- 多语言支持（英文、中文等）
- 依赖检查和优雅降级
- 超时控制和内存管理

依赖要求：
- pdf2image: PDF转图片库（需要系统安装poppler）
- pytesseract: OCR库（需要系统安装tesseract-ocr）
- Pillow: 图像处理库
"""

import io
import logging
import shutil
import subprocess
import tempfile
from typing import Any, Dict, List, Optional, Tuple, Union

# 模块日志器
logger = logging.getLogger(__name__)

# 可选依赖导入（优雅降级）
try:
    from pdf2image import convert_from_bytes
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False
    logger.warning("pdf2image未安装，OCR功能将不可用")

try:
    import pytesseract
    from PIL import Image
    PYTESSERACT_AVAILABLE = True
except ImportError:
    PYTESSERACT_AVAILABLE = False
    logger.warning("pytesseract或Pillow未安装，OCR功能将不可用")

try:
    import easyocr
    EASYOCR_AVAILABLE = True
except ImportError:
    EASYOCR_AVAILABLE = False
    logger.debug("easyocr未安装，将使用pytesseract作为首选OCR引擎")

# EasyOCR reader 单例缓存（避免重复加载模型）
_easyocr_reader = None

# 从utils导入配置类
try:
    from .utils import PDFExtractorConfig
except ImportError:
    # 独立运行时的降级处理
    PDFExtractorConfig = None


class OCRHandler:
    """OCR处理类，负责PDF扫描件的文本提取。

    该类封装了PDF转图片和OCR识别的完整流程，支持多语言识别、
    超时控制和DPI配置。当依赖不可用时，会优雅降级并返回错误信息。

    Attributes:
        languages: OCR识别语言列表
        timeout: OCR处理超时时间（秒）
        dpi: PDF转图片的DPI设置
        config: 配置对象

    Example:
        >>> handler = OCRHandler()
        >>> if handler.is_available():
        ...     result = handler.extract_text(pdf_data, max_pages=10)
        ...     print(result["text"])
    """

    # 默认配置
    DEFAULT_LANGUAGES = ["eng"]
    DEFAULT_TIMEOUT = 30
    DEFAULT_DPI = 300
    MAX_MEMORY_MB = 500  # 最大内存使用限制（MB）

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        """初始化OCR处理器。

        Args:
            config: 配置字典，可包含以下键：
                - ocr.languages: 语言列表，如 ["eng", "chi_sim"]
                - ocr.timeout: 超时时间（秒）
                - ocr.dpi: PDF转图片DPI

        Example:
            >>> config = {"ocr": {"languages": ["eng", "chi_sim"], "dpi": 200}}
            >>> handler = OCRHandler(config)
        """
        self._config_dict = config or {}
        self._config = None

        # 尝试使用PDFExtractorConfig
        if PDFExtractorConfig is not None:
            try:
                self._config = PDFExtractorConfig(config)
                self.languages: List[str] = self._config.get(
                    "ocr.language", self.DEFAULT_LANGUAGES
                )
                self.timeout: int = self._config.get(
                    "ocr.timeout", self.DEFAULT_TIMEOUT
                )
                self.dpi: int = self._config.get(
                    "ocr.dpi", self.DEFAULT_DPI
                )
            except Exception as e:
                logger.warning(f"PDFExtractorConfig初始化失败，使用默认配置: {e}")
                self._apply_default_config()
        else:
            self._apply_default_config()

        # 检查依赖可用性
        self._pdf2image_available = PDF2IMAGE_AVAILABLE
        self._pytesseract_available = PYTESSERACT_AVAILABLE
        self._easyocr_available = EASYOCR_AVAILABLE

        # 缓存依赖检查结果
        self._poppler_available: Optional[bool] = None
        self._tesseract_available: Optional[bool] = None

        logger.debug(
            "OCRHandler初始化完成: languages=%s, timeout=%d, dpi=%d, easyocr=%s",
            self.languages, self.timeout, self.dpi, self._easyocr_available
        )

    def _apply_default_config(self) -> None:
        """应用默认配置（当PDFExtractorConfig不可用时）。"""
        ocr_config = self._config_dict.get("ocr", {})
        self.languages = ocr_config.get("language", self.DEFAULT_LANGUAGES)
        if isinstance(self.languages, str):
            self.languages = [self.languages]
        self.timeout = ocr_config.get("timeout", self.DEFAULT_TIMEOUT)
        self.dpi = ocr_config.get("dpi", self.DEFAULT_DPI)

    def is_available(self) -> bool:
        """检查OCR环境是否完全可用。

        检查内容包括：
        1. pdf2image库是否安装（PDF OCR需要）
        2. pytesseract库是否安装 或 easyocr库是否安装
        3. 系统poppler是否安装（pdf2image依赖，PDF OCR需要）
        4. 系统tesseract是否安装（pytesseract依赖，有easyocr时可跳过）

        Returns:
            True如果OCR依赖可用（pytesseract或easyocr至少一个可用），False否则

        Example:
            >>> handler = OCRHandler()
            >>> if handler.is_available():
            ...     # 执行OCR提取
            ... else:
            ...     # 跳过OCR或使用备选方案
        """
        # 优先检查 pytesseract + tesseract 路径
        tesseract_ok = (self._pytesseract_available and self._check_tesseract())
        if tesseract_ok:
            return True

        # 其次检查 easyocr 路径（不需要系统级依赖）
        if self._easyocr_available:
            logger.debug("pytesseract/tesseract不可用，但easyocr可用，OCR仍可使用")
            return True

        logger.debug("既没有可用的pytesseract/tesseract，也没有easyocr，OCR不可用")
        return False

    def is_image_ocr_available(self) -> bool:
        """检查图片OCR是否可用（不需要pdf2image和poppler）。

        对于直接从图片文件提取文本，不需要pdf2image和poppler，
        只需要pytesseract/tesseract或easyocr。

        Returns:
            True如果图片OCR可用
        """
        tesseract_ok = (self._pytesseract_available and self._check_tesseract())
        if tesseract_ok:
            return True
        if self._easyocr_available:
            return True
        return False

    def _check_poppler(self) -> bool:
        """检查poppler是否已安装（pdf2image的系统依赖）。

        Returns:
            True如果poppler可用，False否则
        """
        if self._poppler_available is not None:
            return self._poppler_available

        try:
            # 尝试使用pdf2image转换一个空PDF来检测poppler
            # 实际上pdf2image会在调用时检查pdftoppm
            if not PDF2IMAGE_AVAILABLE:
                self._poppler_available = False
                return False

            # 检查pdftoppm命令是否存在
            pdftoppm_path = shutil.which("pdftoppm")
            if pdftoppm_path:
                self._poppler_available = True
                logger.debug(f"找到pdftoppm: {pdftoppm_path}")
                return True

            # Windows上可能使用pdftoppm.exe
            pdftoppm_path = shutil.which("pdftoppm.exe")
            if pdftoppm_path:
                self._poppler_available = True
                logger.debug(f"找到pdftoppm.exe: {pdftoppm_path}")
                return True

            self._poppler_available = False
            return False
        except Exception as e:
            logger.debug(f"检查poppler时出错: {e}")
            self._poppler_available = False
            return False

    def _check_tesseract(self) -> bool:
        """检查tesseract是否已安装（pytesseract的系统依赖）。

        Returns:
            True如果tesseract可用，False否则
        """
        if self._tesseract_available is not None:
            return self._tesseract_available

        try:
            if not PYTESSERACT_AVAILABLE:
                self._tesseract_available = False
                return False

            # 使用pytesseract内置方法检查
            try:
                version = pytesseract.get_tesseract_version()
                logger.debug(f"找到tesseract版本: {version}")
                self._tesseract_available = True
                return True
            except Exception as e:
                logger.debug(f"pytesseract无法找到tesseract: {e}")
                self._tesseract_available = False
                return False
        except Exception as e:
            logger.debug(f"检查tesseract时出错: {e}")
            self._tesseract_available = False
            return False

    def check_pdf_has_text(self, pdf_data: bytes) -> bool:
        """检查PDF是否已有可提取的文本内容。

        通过尝试使用PyPDF2快速提取第一页文本来判断PDF是否为扫描件。
        这可以帮助避免对已有文本的PDF进行不必要的OCR处理。

        Args:
            pdf_data: PDF文件的字节数据

        Returns:
            True如果PDF包含可提取的文本，False如果可能是扫描件

        Example:
            >>> handler = OCRHandler()
            >>> if not handler.check_pdf_has_text(pdf_data):
            ...     # PDF可能是扫描件，需要OCR
            ...     result = handler.extract_text(pdf_data)
        """
        try:
            # 尝试导入PyPDF2进行快速文本检查
            try:
                from PyPDF2 import PdfReader
            except ImportError:
                logger.debug("PyPDF2未安装，无法检查PDF文本内容")
                return False

            # 读取PDF并检查第一页文本
            reader = PdfReader(io.BytesIO(pdf_data))
            if len(reader.pages) == 0:
                return False

            # 检查前几页是否有文本
            pages_to_check = min(3, len(reader.pages))
            total_text_length = 0

            for i in range(pages_to_check):
                try:
                    page = reader.pages[i]
                    text = page.extract_text()
                    if text:
                        total_text_length += len(text.strip())
                except Exception as e:
                    logger.debug(f"检查第{i}页时出错: {e}")
                    continue

            # 如果前几页有超过100个字符的文本，认为是文本型PDF
            has_text = total_text_length > 100
            logger.debug(f"PDF文本检查结果: has_text={has_text}, length={total_text_length}")
            return has_text

        except Exception as e:
            logger.debug(f"检查PDF文本内容时出错: {e}")
            return False

    def extract_text(
        self,
        pdf_data: bytes,
        max_pages: int = 50,
        ocr_languages: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """从PDF中提取OCR文本。

        这是OCR处理的主要入口方法，执行完整的PDF转图片和OCR识别流程。
        支持多语言识别、分页限制和超时控制。

        Args:
            pdf_data: PDF文件的字节数据
            max_pages: 最大处理页数，默认50
            ocr_languages: OCR语言列表，如["eng", "chi_sim"]，
                          为None时使用初始化配置的语言

        Returns:
            包含提取结果的字典，格式如下：
            {
                "success": bool,           # 提取是否成功
                "text": str,               # 提取的文本内容
                "page_count": int,         # PDF总页数
                "pages_processed": int,    # 实际处理的页数
                "used_ocr": True,          # 是否使用了OCR（始终为True）
                "method": "ocr",           # 提取方法
                "error": Optional[str],    # 错误信息（成功时为None）
                "quality_indicators": {    # 质量指标
                    "has_scanned_pages": bool,
                    "extraction_confidence": float
                }
            }

        Example:
            >>> handler = OCRHandler()
            >>> result = handler.extract_text(pdf_data, max_pages=10)
            >>> if result["success"]:
            ...     print(f"提取文本: {result['text'][:500]}")
            ... else:
            ...     print(f"提取失败: {result['error']}")
        """
        # 检查依赖可用性
        if not self.is_available():
            error_msg = "OCR依赖不可用"
            if not self._pdf2image_available:
                error_msg += "：pdf2image库未安装"
            elif not self._pytesseract_available:
                error_msg += "：pytesseract库未安装"
            elif not self._check_poppler():
                error_msg += "：poppler系统依赖未安装"
            elif not self._check_tesseract():
                error_msg += "：tesseract系统依赖未安装"

            logger.error(error_msg)
            return self._create_error_result(error_msg)

        # 验证输入数据
        if not pdf_data or len(pdf_data) == 0:
            error_msg = "PDF数据为空"
            logger.error(error_msg)
            return self._create_error_result(error_msg)

        # 检查文件大小（避免内存问题）
        file_size_mb = len(pdf_data) / (1024 * 1024)
        if file_size_mb > 100:  # 100MB限制
            error_msg = f"PDF文件过大({file_size_mb:.1f}MB)，OCR处理可能耗尽内存"
            logger.warning(error_msg)
            # 继续处理，但记录警告

        # 确定使用的语言
        languages = ocr_languages or self.languages
        lang_string = "+".join(languages) if languages else "eng"

        logger.info(
            "开始OCR提取: size=%.1fMB, max_pages=%d, languages=%s",
            file_size_mb, max_pages, languages
        )

        try:
            # 步骤1: PDF转图片
            images, total_pages = self._pdf_to_images(pdf_data, max_pages)

            if not images:
                error_msg = "PDF转图片失败，未生成任何图像"
                logger.error(error_msg)
                return self._create_error_result(error_msg)

            pages_processed = len(images)
            logger.debug(f"PDF转图片完成: {pages_processed}/{total_pages}页")

            # 步骤2: OCR识别
            extracted_texts = []
            total_confidence = 0.0

            for i, image in enumerate(images):
                try:
                    text, confidence = self._ocr_image(image, lang_string)
                    extracted_texts.append(text)
                    total_confidence += confidence
                    logger.debug(f"第{i+1}/{pages_processed}页OCR完成: confidence={confidence:.2f}")
                except Exception as e:
                    logger.warning(f"第{i+1}页OCR失败: {e}")
                    extracted_texts.append("")

            # 合并所有页面的文本
            full_text = "\n\n".join(
                f"--- Page {i+1} ---\n{text}"
                for i, text in enumerate(extracted_texts)
                if text.strip()
            )

            # 计算平均置信度
            avg_confidence = total_confidence / pages_processed if pages_processed > 0 else 0.0

            # 判断是否为扫描件（OCR处理的通常就是扫描件）
            has_scanned_pages = pages_processed > 0

            logger.info(
                "OCR提取完成: pages=%d, text_length=%d, confidence=%.2f",
                pages_processed, len(full_text), avg_confidence
            )

            return {
                "success": True,
                "text": full_text,
                "page_count": total_pages,
                "pages_processed": pages_processed,
                "used_ocr": True,
                "method": "ocr",
                "error": None,
                "quality_indicators": {
                    "has_scanned_pages": has_scanned_pages,
                    "extraction_confidence": round(avg_confidence, 2)
                }
            }

        except MemoryError as e:
            error_msg = f"OCR处理时内存不足: {e}"
            logger.error(error_msg)
            return self._create_error_result(error_msg)
        except Exception as e:
            error_msg = f"OCR处理时发生错误: {type(e).__name__}: {e}"
            logger.exception(error_msg)
            return self._create_error_result(error_msg)

    def _pdf_to_images(
        self,
        pdf_data: bytes,
        max_pages: int
    ) -> Tuple[List[Any], int]:
        """将PDF页面转换为图片列表。

        Args:
            pdf_data: PDF文件的字节数据
            max_pages: 最大转换页数

        Returns:
            (图片列表, PDF总页数)的元组

        Raises:
            RuntimeError: 当pdf2image不可用时
            Exception: 转换过程中的其他错误
        """
        if not PDF2IMAGE_AVAILABLE:
            raise RuntimeError("pdf2image库未安装")

        try:
            # 使用pdf2image转换PDF为图片
            # first_page和last_page用于限制页数
            images = convert_from_bytes(
                pdf_data,
                dpi=self.dpi,
                fmt="png",  # 使用PNG格式，质量较好
                first_page=1,
                last_page=max_pages
            )

            # 尝试获取总页数
            total_pages = len(images)
            try:
                # 使用pdfinfo获取准确页数
                import subprocess
                with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                    tmp.write(pdf_data)
                    tmp_path = tmp.name

                try:
                    result = subprocess.run(
                        ["pdfinfo", tmp_path],
                        capture_output=True,
                        text=True,
                        timeout=10
                    )
                    for line in result.stdout.split("\n"):
                        if line.startswith("Pages:"):
                            total_pages = int(line.split(":")[1].strip())
                            break
                finally:
                    import os
                    os.unlink(tmp_path)
            except Exception as e:
                logger.debug(f"获取PDF总页数失败: {e}，使用转换的页数")
                total_pages = len(images)

            return images, total_pages

        except Exception as e:
            logger.error(f"PDF转图片失败: {e}")
            raise

    def _ocr_image(
        self,
        image: Any,
        lang_string: str
    ) -> Tuple[str, float]:
        """对单张图片执行OCR识别（优先pytesseract，备选easyocr）。

        Args:
            image: PIL Image对象
            lang_string: OCR语言字符串，如"eng+chi_sim"

        Returns:
            (识别文本, 置信度)的元组

        Raises:
            RuntimeError: 当所有OCR引擎都不可用时
            Exception: OCR过程中的其他错误
        """
        # 优先使用 pytesseract
        if PYTESSERACT_AVAILABLE and self._check_tesseract():
            try:
                return self._ocr_image_tesseract(image, lang_string)
            except Exception as e:
                logger.warning(f"pytesseract OCR失败，尝试easyocr: {e}")

        # 备选使用 easyocr
        if EASYOCR_AVAILABLE:
            try:
                return self._ocr_image_easyocr(image)
            except Exception as e:
                logger.error(f"easyocr OCR也失败: {e}")
                raise

        raise RuntimeError("pytesseract/tesseract和easyocr均不可用，无法执行OCR")

    def _ocr_image_tesseract(
        self,
        image: Any,
        lang_string: str
    ) -> Tuple[str, float]:
        """使用pytesseract对单张图片执行OCR识别。

        Args:
            image: PIL Image对象
            lang_string: OCR语言字符串，如"eng+chi_sim"

        Returns:
            (识别文本, 置信度)的元组
        """
        try:
            custom_config = r'--oem 3 --psm 6'
            text = pytesseract.image_to_string(
                image,
                lang=lang_string,
                config=custom_config
            )

            confidence = 0.0
            try:
                data = pytesseract.image_to_data(
                    image,
                    lang=lang_string,
                    config=custom_config,
                    output_type=pytesseract.Output.DICT
                )
                confidences = [int(c) for c in data.get("conf", []) if int(c) > 0]
                if confidences:
                    confidence = sum(confidences) / len(confidences) / 100.0
            except Exception as e:
                logger.debug(f"获取OCR置信度失败: {e}")
                confidence = 0.5

            return text.strip(), confidence

        except Exception as e:
            logger.error(f"pytesseract OCR识别失败: {e}")
            raise

    def _ocr_image_easyocr(
        self,
        image: Any
    ) -> Tuple[str, float]:
        """使用easyocr对单张图片执行OCR识别。

        Args:
            image: PIL Image对象

        Returns:
            (识别文本, 置信度)的元组
        """
        global _easyocr_reader

        try:
            import numpy as np

            if _easyocr_reader is None:
                # 根据配置的语言列表确定easyocr语言
                # easyocr使用ISO 639代码: 'en', 'ch_sim', 'ja', 'ko'等
                easyocr_langs = self._convert_to_easyocr_langs(self.languages)
                logger.info(f"初始化EasyOCR reader: languages={easyocr_langs}")
                _easyocr_reader = easyocr.Reader(easyocr_langs, gpu=False)

            # PIL Image -> numpy array
            img_array = np.array(image)

            # 执行OCR
            results = _easyocr_reader.readtext(img_array)

            # 拼接所有识别的文本
            text_parts = []
            total_confidence = 0.0
            count = 0

            for (bbox, text, conf) in results:
                if text.strip():
                    text_parts.append(text.strip())
                    total_confidence += conf
                    count += 1

            full_text = "\n".join(text_parts)
            avg_confidence = total_confidence / count if count > 0 else 0.0

            logger.info(
                f"EasyOCR识别完成: text_length=%d, confidence=%.2f, regions=%d",
                len(full_text), avg_confidence, count
            )

            return full_text, avg_confidence

        except Exception as e:
            logger.error(f"EasyOCR识别失败: {e}")
            raise

    def _convert_to_easyocr_langs(self, langs: List[str]) -> List[str]:
        """将pytesseract语言代码转换为EasyOCR语言代码。

        Args:
            langs: pytesseract语言代码列表，如["eng", "chi_sim"]

        Returns:
            EasyOCR语言代码列表，如["en", "ch_sim"]
        """
        lang_map = {
            "eng": "en",
            "chi_sim": "ch_sim",
            "chi_tra": "ch_tra",
            "jpn": "ja",
            "kor": "ko",
            "fra": "fr",
            "deu": "de",
            "spa": "es",
            "rus": "ru",
            "por": "pt",
            "ita": "it",
        }
        result = []
        for lang in langs:
            mapped = lang_map.get(lang, lang)
            if mapped not in result:
                result.append(mapped)
        if not result:
            result = ["en", "ch_sim"]
        return result

    def extract_text_from_image(
        self,
        image_data: bytes,
        ocr_languages: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """从图片文件中提取OCR文本。

        支持PNG、JPEG、BMP、TIFF等格式的图片文件，
        优先使用pytesseract，不可用时回退到easyocr。

        Args:
            image_data: 图片文件的字节数据
            ocr_languages: OCR语言列表，如["eng", "chi_sim"]，
                          为None时使用初始化配置的语言

        Returns:
            包含提取结果的字典，格式如下：
            {
                "success": bool,
                "text": str,
                "page_count": 1,
                "pages_processed": 1,
                "used_ocr": True,
                "method": "image_ocr",
                "error": Optional[str],
                "quality_indicators": {
                    "has_scanned_pages": bool,
                    "extraction_confidence": float
                }
            }

        Example:
            >>> handler = OCRHandler()
            >>> with open("scan.png", "rb") as f:
            ...     result = handler.extract_text_from_image(f.read())
            >>> if result["success"]:
            ...     print(result["text"])
        """
        # 检查图片OCR依赖（pytesseract+Pillow 或 easyocr）
        if not self.is_image_ocr_available():
            error_msg = "无可用OCR引擎（需要pytesseract+Pillow+Tesseract 或 easyocr）"
            logger.error(error_msg)
            return self._create_image_error_result(error_msg)

        # 验证输入数据
        if not image_data or len(image_data) == 0:
            error_msg = "图片数据为空"
            logger.error(error_msg)
            return self._create_image_error_result(error_msg)

        # 确定使用的语言
        languages = ocr_languages or self.languages
        lang_string = "+".join(languages) if languages else "eng"

        # 确定使用的OCR引擎
        use_tesseract = PYTESSERACT_AVAILABLE and self._check_tesseract()
        engine_name = "pytesseract" if use_tesseract else "easyocr"

        logger.info(
            "开始图片OCR提取: size=%d bytes, languages=%s, engine=%s",
            len(image_data), languages, engine_name
        )

        try:
            # 从字节数据加载PIL Image
            image = Image.open(io.BytesIO(image_data))
            
            # 执行OCR识别
            text, confidence = self._ocr_image(image, lang_string)

            logger.info(
                "图片OCR提取完成(%s): text_length=%d, confidence=%.2f",
                engine_name, len(text), confidence
            )

            return {
                "success": bool(text.strip()),
                "text": text,
                "page_count": 1,
                "pages_processed": 1,
                "used_ocr": True,
                "method": f"image_ocr_{engine_name}",
                "error": None,
                "quality_indicators": {
                    "has_scanned_pages": True,
                    "extraction_confidence": round(confidence, 2)
                }
            }

        except Exception as e:
            error_msg = f"图片OCR处理时发生错误({engine_name}): {type(e).__name__}: {e}"
            logger.exception(error_msg)
            return self._create_image_error_result(error_msg)

    def extract_text_from_image_file(
        self,
        file_path: str,
        ocr_languages: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """从图片文件路径提取OCR文本。

        Args:
            file_path: 图片文件路径
            ocr_languages: OCR语言列表

        Returns:
            提取结果字典
        """
        logger.info(f"从图片文件提取OCR文本: {file_path}")

        try:
            with open(file_path, 'rb') as f:
                image_data = f.read()

            logger.info(f"读取图片文件成功，大小: {len(image_data)} bytes")

            return self.extract_text_from_image(image_data, ocr_languages)

        except FileNotFoundError:
            error_msg = f"图片文件不存在: {file_path}"
            return self._create_image_error_result(error_msg)
        except PermissionError:
            error_msg = f"无权限访问图片文件: {file_path}"
            return self._create_image_error_result(error_msg)
        except Exception as e:
            error_msg = f"读取图片文件失败: {type(e).__name__}: {e}"
            logger.exception(error_msg)
            return self._create_image_error_result(error_msg)

    def _create_image_error_result(self, error_msg: str) -> Dict[str, Any]:
        """创建图片OCR错误结果字典。

        Args:
            error_msg: 错误信息

        Returns:
            格式化的错误结果字典
        """
        return {
            "success": False,
            "text": "",
            "page_count": 0,
            "pages_processed": 0,
            "used_ocr": True,
            "method": "image_ocr",
            "error": error_msg,
            "quality_indicators": {
                "has_scanned_pages": False,
                "extraction_confidence": 0.0
            }
        }

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
            "page_count": 0,
            "pages_processed": 0,
            "used_ocr": True,
            "method": "ocr",
            "error": error_msg,
            "quality_indicators": {
                "has_scanned_pages": False,
                "extraction_confidence": 0.0
            }
        }

    def get_status(self) -> Dict[str, Any]:
        """获取OCR处理器的当前状态信息。

        Returns:
            包含状态信息的字典
        """
        return {
            "available": self.is_available(),
            "image_ocr_available": self.is_image_ocr_available(),
            "pdf2image_installed": self._pdf2image_available,
            "pytesseract_installed": self._pytesseract_available,
            "easyocr_installed": self._easyocr_available,
            "poppler_installed": self._check_poppler(),
            "tesseract_installed": self._check_tesseract(),
            "config": {
                "languages": self.languages,
                "timeout": self.timeout,
                "dpi": self.dpi
            }
        }


def check_ocr_dependencies() -> Dict[str, bool]:
    """检查所有OCR相关的依赖是否已安装。

    这是一个独立的工具函数，用于在安装或启动时检查环境。

    Returns:
        依赖状态字典，包含以下键：
        - pdf2image: Python库pdf2image是否安装
        - pytesseract: Python库pytesseract是否安装
        - poppler: 系统依赖poppler是否安装
        - tesseract: 系统依赖tesseract是否安装
        - all_available: 所有依赖是否都可用

    Example:
        >>> status = check_ocr_dependencies()
        >>> if status["all_available"]:
        ...     print("OCR功能完全可用")
        ... else:
        ...     print(f"缺少依赖: {status}")
    """
    handler = OCRHandler()
    status = handler.get_status()

    return {
        "pdf2image": status["pdf2image_installed"],
        "pytesseract": status["pytesseract_installed"],
        "poppler": status["poppler_installed"],
        "tesseract": status["tesseract_installed"],
        "all_available": status["available"]
    }


# 向后兼容的别名
extract_text_with_ocr = OCRHandler.extract_text