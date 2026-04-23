"""
PDF文本提取模块 - 接口层 (__init__.py)

PDF Extractor - 一个功能强大的PDF文本提取Python模块

本模块提供完整的PDF文本提取功能，支持多种提取策略（pdfplumber、PyPDF2、OCR），
并提供与AI系统的无缝集成能力。

主要功能:
    - 多策略PDF文本提取（原生文本提取 + OCR扫描件识别）
    - 智能降级策略（pdfplumber → PyPDF2 → OCR）
    - 缓存机制支持，提升重复提取性能
    - 并行处理多页PDF，优化大文件处理
    - AI系统集成桥接，支持邮件附件分析
    - 完善的配置管理和依赖检查

使用示例:
    # 基础用法 - 提取PDF文本
    >>> from pdf_extractor import extract_pdf_content
    >>> result = extract_pdf_content(pdf_bytes)
    >>> print(result["data"]["extracted_text"])

    # 启用OCR处理扫描件
    >>> result = extract_pdf_content(pdf_bytes, use_ocr=True, ocr_languages=["eng", "chi_sim"])

    # 使用提取器类进行高级配置
    >>> from pdf_extractor import get_extractor
    >>> extractor = get_extractor({"performance": {"max_pages": 100}})
    >>> result = extractor.extract(pdf_bytes)

    # AI系统集成
    >>> from pdf_extractor import get_ai_bridge, EmailAttachment
    >>> bridge = get_ai_bridge(ai_model_instance)
    >>> attachment = EmailAttachment(filename="doc.pdf", content=pdf_bytes, 
    ...                              content_type="application/pdf", size=len(pdf_bytes))
    >>> analysis = await bridge.process_email_attachment("email_001", attachment)

    # 检查依赖状态
    >>> from pdf_extractor import check_dependencies
    >>> deps = check_dependencies()
    >>> print(f"pdfplumber可用: {deps['pdfplumber']}")

依赖要求:
    必需依赖:
        - Python 3.8+
    
    推荐依赖（用于原生文本提取）:
        - pdfplumber: 主要提取引擎，提取效果最佳
        - PyPDF2: 备用提取引擎
    
    可选依赖（用于OCR扫描件识别）:
        - pdf2image: PDF转图片（需要系统安装poppler）
        - pytesseract: OCR识别引擎（需要系统安装tesseract-ocr）
        - Pillow: 图像处理

版本信息:
    - 版本: 1.0.0
    - 作者: PDF Extractor Team
    - 许可证: MIT

更多信息:
    - 文档: 参见 .cospec/pdf-extractor/design.md
    - 源码: pdf_extractor/ 目录
"""

import logging
from typing import Any, Dict, List, Optional, Union

# 模块版本信息
__version__ = "1.0.0"
__author__ = "PDF Extractor Team"
__description__ = "PDF文本提取模块 - 支持多策略提取和AI系统集成"

# 模块日志器
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 公共API导出
# ---------------------------------------------------------------------------

# 从 utils.py 导出工具类和函数
from .utils import (
    PDFExtractorConfig,      # 配置管理类
    ExtractionCache,         # 缓存管理类
    calculate_hash,          # 哈希计算函数
    normalize_pdf_input,     # 输入标准化函数
    format_extraction_result,# 结果格式化函数
)

# 从 core.py 导出核心类
from .core import (
    PDFTextExtractor,        # 主提取器类
)

# 从 ocr_handler.py 导出OCR相关类和函数
from .ocr_handler import (
    OCRHandler,              # OCR处理器类
    check_ocr_dependencies,  # OCR依赖检查函数
    extract_text_with_ocr,    # 向后兼容别名
)

# 从 integrations.py 导出集成相关类和数据类
from .integrations import (
    PDFToAIBridge,           # AI集成桥接类
    EmailAttachment,         # 邮件附件数据类
    AnalysisResult,          # 分析结果数据类
)


# ---------------------------------------------------------------------------
# 核心便捷函数
# ---------------------------------------------------------------------------

def extract_pdf_content(
    pdf_data: Union[bytes, str],
    use_ocr: bool = False,
    ocr_languages: List[str] = None,
    max_pages: int = 50,
    config: Optional[Dict] = None
) -> Dict[str, Any]:
    """提取PDF文本内容的主函数。

    这是用户最常用的便捷函数，封装了完整的PDF提取流程。
    支持原生文本提取和OCR扫描件识别，自动处理各种输入格式。

    Args:
        pdf_data: PDF原始数据，支持以下格式：
            - bytes: PDF文件的二进制数据
            - str: base64编码的PDF字符串
        use_ocr: 是否启用OCR识别，用于处理扫描件PDF（默认False）
        ocr_languages: OCR识别语言列表，如 ["eng", "chi_sim"]（默认["eng"]）
        max_pages: 最大处理页数，超过将截断（默认50）
        config: 额外配置参数字典，用于覆盖默认配置（默认None）

    Returns:
        Dict[str, Any]: 统一格式的提取结果，包含以下字段：
            {
                "status": "success|partial|error",  # 提取状态
                "data": {
                    "extracted_text": str,          # 提取的文本内容
                    "summary": str,                 # 文本摘要
                    "statistics": Dict,             # 统计信息
                    "quality_indicators": Dict      # 质量指标
                },
                "compatibility": {
                    "ai_ready": bool,               # 是否适合AI处理
                    "format": str,                  # 输出格式版本
                    "truncated": bool               # 是否被截断
                }
            }

    Raises:
        ValueError: 当输入数据格式无效时抛出
        RuntimeError: 当提取过程中发生严重错误时抛出

    Example:
        # 基础用法
        >>> with open("document.pdf", "rb") as f:
        ...     result = extract_pdf_content(f.read())
        >>> if result["status"] == "success":
        ...     print(result["data"]["extracted_text"][:500])

        # 处理扫描件PDF
        >>> result = extract_pdf_content(
        ...     pdf_bytes,
        ...     use_ocr=True,
        ...     ocr_languages=["eng", "chi_sim"],
        ...     max_pages=10
        ... )

        # 使用自定义配置
        >>> result = extract_pdf_content(
        ...     pdf_bytes,
        ...     config={"performance": {"cache_results": False}}
        ... )
    """
    if ocr_languages is None:
        ocr_languages = ["eng"]

    try:
        # 标准化输入数据
        normalized_data = normalize_pdf_input(pdf_data)
        
        # 合并配置
        merged_config = config or {}
        if use_ocr:
            merged_config.setdefault("ocr", {})
            merged_config["ocr"]["enabled"] = True
            merged_config["ocr"]["language"] = ocr_languages
        
        merged_config.setdefault("performance", {})
        merged_config["performance"]["max_pages"] = max_pages

        # 创建提取器并执行提取
        extractor = PDFTextExtractor(merged_config)
        extraction_result = extractor.extract(normalized_data, use_ocr=use_ocr)

        # extractor.extract() 已经由 _format_result 进行了格式化
        # 直接使用结果，将其转换为统一的 status/data/compatibility 格式
        if extraction_result.get("success"):
            formatted_result = {
                "status": "success",
                "data": {
                    "extracted_text": extraction_result.get("text", ""),
                    "summary": extraction_result.get("text", "")[:500],
                    "statistics": {
                        "page_count": extraction_result.get("page_count", 0),
                        "pages_processed": extraction_result.get("pages_processed", 0),
                        "method": extraction_result.get("method", "unknown"),
                        "used_ocr": extraction_result.get("used_ocr", False),
                        "truncated": extraction_result.get("truncated", False),
                    },
                    "quality_indicators": extraction_result.get("metadata", {}).get("quality_indicators", {}),
                },
                "compatibility": {
                    "ai_ready": True,
                    "format": "ai_analysis_v1",
                    "truncated": extraction_result.get("truncated", False),
                },
            }
        else:
            formatted_result = {
                "status": "error",
                "data": {
                    "extracted_text": "",
                    "summary": "",
                    "statistics": {},
                    "quality_indicators": {},
                    "error": extraction_result.get("error", "未知错误"),
                },
                "compatibility": {
                    "ai_ready": False,
                    "format": "ai_analysis_v1",
                    "truncated": False,
                },
            }

        logger.info(
            "PDF提取完成: status=%s, pages=%d, text_length=%d",
            formatted_result.get("status", "unknown"),
            extraction_result.get("page_count", 0),
            len(extraction_result.get("text", ""))
        )

        return formatted_result

    except Exception as e:
        logger.error("PDF提取失败: %s", str(e), exc_info=True)
        return {
            "status": "error",
            "data": {
                "extracted_text": "",
                "summary": "",
                "statistics": {},
                "quality_indicators": {"error": str(e)}
            },
            "compatibility": {
                "ai_ready": False,
                "format": "1.0",
                "truncated": False
            }
        }


def get_extractor(config: Optional[Dict] = None) -> PDFTextExtractor:
    """获取PDFTextExtractor实例。

    工厂函数，用于创建配置好的PDF文本提取器实例。

    Args:
        config: 配置字典，用于覆盖默认配置（默认None）
            支持的配置项：
            - performance.cache_results: 是否启用缓存（默认True）
            - performance.max_pages: 默认最大处理页数（默认50）
            - performance.use_async: 是否启用并行处理（默认True）
            - ocr.enabled: 是否启用OCR（默认True）
            - ocr.language: OCR语言列表

    Returns:
        PDFTextExtractor: 配置好的提取器实例

    Example:
        >>> extractor = get_extractor({"performance": {"max_pages": 100}})
        >>> result = extractor.extract(pdf_bytes)
        >>> print(f"提取了 {result['page_count']} 页")
    """
    return PDFTextExtractor(config)


def get_ai_bridge(ai_model: Any, config: Optional[Dict] = None) -> PDFToAIBridge:
    """获取PDFToAIBridge实例。

    工厂函数，用于创建与AI系统集成的桥接器实例。

    Args:
        ai_model: AI模型实例，需要实现analyze方法
        config: 配置字典，用于自定义桥接器行为（默认None）
            支持的配置项：
            - ai_integration.max_text_length: 最大文本长度（默认10000）
            - ai_integration.include_metadata: 是否包含元数据（默认True）

    Returns:
        PDFToAIBridge: 配置好的AI桥接器实例

    Example:
        >>> # ai_model 是已有的AI模型实例
        >>> bridge = get_ai_bridge(ai_model, {"ai_integration": {"max_text_length": 5000}})
        >>> attachment = EmailAttachment(
        ...     filename="report.pdf",
        ...     content=pdf_bytes,
        ...     content_type="application/pdf",
        ...     size=len(pdf_bytes)
        ... )
        >>> result = await bridge.process_email_attachment("email_001", attachment)
    """
    return PDFToAIBridge(ai_model=ai_model, config=config)


def check_dependencies() -> Dict[str, Any]:
    """检查所有依赖是否可用。

    检查PDF提取模块所需的所有依赖项的安装状态，
    包括必需依赖和可选依赖。

    Returns:
        Dict[str, Any]: 依赖状态字典，包含以下字段：
            {
                "pdfplumber": bool,      # PDF提取引擎（推荐）
                "pypdf2": bool,          # 备用提取引擎（推荐）
                "pdf2image": bool,       # PDF转图片（OCR必需）
                "pytesseract": bool,     # OCR引擎（OCR必需）
                "pillow": bool,          # 图像处理（OCR必需）
                "ocr_available": bool,   # OCR功能整体可用性
                "core_available": bool   # 核心提取功能可用性
            }

    Example:
        >>> deps = check_dependencies()
        >>> print(f"核心功能可用: {deps['core_available']}")
        >>> print(f"OCR功能可用: {deps['ocr_available']}")
        >>> if not deps["pdfplumber"]:
        ...     print("建议安装 pdfplumber 以获得最佳提取效果")
    """
    # 检查核心依赖
    core_deps = {}
    try:
        import pdfplumber
        core_deps["pdfplumber"] = True
    except ImportError:
        core_deps["pdfplumber"] = False

    try:
        from PyPDF2 import PdfReader
        core_deps["pypdf2"] = True
    except ImportError:
        core_deps["pypdf2"] = False

    # 检查OCR依赖
    ocr_deps = check_ocr_dependencies()
    
    # 计算整体可用性
    core_available = core_deps["pdfplumber"] or core_deps["pypdf2"]
    ocr_available = ocr_deps.get("pdf2image", False) and ocr_deps.get("pytesseract", False)

    result = {
        **core_deps,
        **ocr_deps,
        "ocr_available": ocr_available,
        "core_available": core_available
    }

    logger.debug("依赖检查结果: %s", result)
    return result


def get_version() -> Dict[str, str]:
    """获取模块版本信息。

    Returns:
        Dict[str, str]: 版本信息字典，包含以下字段：
            {
                "version": str,      # 版本号
                "author": str,       # 作者信息
                "description": str   # 模块描述
            }

    Example:
        >>> info = get_version()
        >>> print(f"PDF Extractor 版本: {info['version']}")
        >>> print(f"作者: {info['author']}")
    """
    return {
        "version": __version__,
        "author": __author__,
        "description": __description__
    }


# ---------------------------------------------------------------------------
# 模块初始化
# ---------------------------------------------------------------------------

def _setup_logging():
    """设置模块日志（仅在未配置时）。"""
    if not logging.getLogger().handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )


# 自动设置日志
_setup_logging()

# 模块加载日志
logger.debug("PDF Extractor 模块已加载，版本: %s", __version__)


# ---------------------------------------------------------------------------
# __all__ 定义 - 明确公共API
# ---------------------------------------------------------------------------

__all__ = [
    # 版本信息
    "__version__",
    "__author__",
    "__description__",
    
    # 核心便捷函数
    "extract_pdf_content",
    "get_extractor",
    "get_ai_bridge",
    "check_dependencies",
    "get_version",
    
    # 从 utils.py 导出的类和函数
    "PDFExtractorConfig",
    "ExtractionCache",
    "calculate_hash",
    "normalize_pdf_input",
    "format_extraction_result",
    
    # 从 core.py 导出的类
    "PDFTextExtractor",
    
    # 从 ocr_handler.py 导出的类和函数
    "OCRHandler",
    "check_ocr_dependencies",
    
    # 从 integrations.py 导出的类和数据类
    "PDFToAIBridge",
    "EmailAttachment",
    "AnalysisResult",
]
