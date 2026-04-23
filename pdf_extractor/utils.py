"""
PDF文本提取模块 - 工具层 (utils.py)

提供PDF文本提取过程中所需的各类工具函数和辅助类，包括：
- 配置管理 (PDFExtractorConfig)
- 缓存管理 (ExtractionCache)
- 哈希计算 (calculate_hash)
- 数据转换 (decode_base64_pdf, normalize_pdf_input)
- 输出格式化 (format_extraction_result)
- 文本质量评估 (assess_extraction_quality)
- 文本截断和摘要 (truncate_text, generate_summary)
"""

import base64
import copy
import hashlib
import logging
import math
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple, Union

# 模块日志器
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 默认配置常量
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: Dict[str, Any] = {
    "primary_extractor": "pdfplumber",
    "fallback_extractors": ["pypdf2", "ocr"],
    "ocr": {
        "enabled": True,
        "language": ["eng", "chi_sim"],
        "timeout": 30,
        "dpi": 300,
    },
    "performance": {
        "max_file_size_mb": 50,
        "max_pages": 100,
        "use_async": True,
        "cache_results": True,
    },
    "ai_integration": {
        "max_text_length": 10000,
        "include_metadata": True,
        "format_version": "1.0",
    },
}

# 环境变量前缀
_ENV_PREFIX = "PDF_EXTRACTOR_"

# 支持环境变量覆盖的扁平键映射（环境变量名 -> 点分配置路径）
_ENV_KEY_MAP: Dict[str, str] = {
    "PRIMARY_EXTRACTOR": "primary_extractor",
    "FALLBACK_EXTRACTORS": "fallback_extractors",
    "OCR_ENABLED": "ocr.enabled",
    "OCR_LANGUAGE": "ocr.language",
    "OCR_TIMEOUT": "ocr.timeout",
    "OCR_DPI": "ocr.dpi",
    "PERFORMANCE_MAX_FILE_SIZE_MB": "performance.max_file_size_mb",
    "PERFORMANCE_MAX_PAGES": "performance.max_pages",
    "PERFORMANCE_USE_ASYNC": "performance.use_async",
    "PERFORMANCE_CACHE_RESULTS": "performance.cache_results",
    "AI_INTEGRATION_MAX_TEXT_LENGTH": "ai_integration.max_text_length",
    "AI_INTEGRATION_INCLUDE_METADATA": "ai_integration.include_metadata",
    "AI_INTEGRATION_FORMAT_VERSION": "ai_integration.format_version",
}


# ---------------------------------------------------------------------------
# 配置管理
# ---------------------------------------------------------------------------

class PDFExtractorConfig:
    """PDF文本提取模块的配置管理类。

    支持三层配置合并优先级（由低到高）：
    1. 内置默认配置 (DEFAULT_CONFIG)
    2. 用户自定义配置 (通过构造函数传入)
    3. 环境变量覆盖 (PDF_EXTRACTOR_* 前缀)

    使用示例::

        config = PDFExtractorConfig({"ocr": {"enabled": False}})
        print(config.get("ocr.timeout"))       # 30
        print(config.get("ocr.enabled"))        # False (被用户配置覆盖)
        print(config.get("ai_integration"))     # 返回整个子字典
    """

    def __init__(self, user_config: Optional[Dict[str, Any]] = None) -> None:
        """初始化配置管理器。

        Args:
            user_config: 用户自定义配置字典，用于覆盖默认配置。
                         支持部分覆盖，未提供的配置项将使用默认值。
        """
        # 深拷贝默认配置，避免修改全局常量
        self._config: Dict[str, Any] = copy.deepcopy(DEFAULT_CONFIG)

        # 合并用户配置
        if user_config:
            self._config = self._deep_merge(self._config, user_config)

        # 应用环境变量覆盖
        self._apply_env_overrides()

        logger.debug("PDFExtractorConfig 初始化完成，最终配置: %s", self._config)

    # ------ 公共方法 ------

    def get(self, key: str, default: Optional[Any] = None) -> Any:
        """通过点分路径获取配置值。

        Args:
            key: 配置键，支持点分路径，例如 ``"ocr.timeout"``。
            default: 当键不存在时返回的默认值。

        Returns:
            对应的配置值；键不存在时返回 *default*。

        Examples::

            cfg.get("primary_extractor")           # "pdfplumber"
            cfg.get("ocr.enabled")                 # True
            cfg.get("nonexistent", "fallback")     # "fallback"
        """
        keys = key.split(".")
        value: Any = self._config
        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default
        return value

    def set(self, key: str, value: Any) -> None:
        """通过点分路径设置配置值。

        Args:
            key: 配置键，支持点分路径。
            value: 要设置的值。
        """
        keys = key.split(".")
        config = self._config
        for k in keys[:-1]:
            if k not in config or not isinstance(config[k], dict):
                config[k] = {}
            config = config[k]
        config[keys[-1]] = value
        logger.debug("配置已更新: %s = %s", key, value)

    def to_dict(self) -> Dict[str, Any]:
        """返回配置的深拷贝字典。

        Returns:
            完整配置字典的深拷贝。
        """
        return copy.deepcopy(self._config)

    # ------ 内部方法 ------

    @staticmethod
    def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
        """递归深度合并两个字典。

        *override* 中的值会覆盖 *base* 中对应键的值。
        对于嵌套字典，会递归合并而非直接替换。

        Args:
            base: 基础字典。
            override: 覆盖字典。

        Returns:
            合并后的新字典。
        """
        result = copy.deepcopy(base)
        for key, value in override.items():
            if (
                key in result
                and isinstance(result[key], dict)
                and isinstance(value, dict)
            ):
                result[key] = PDFExtractorConfig._deep_merge(result[key], value)
            else:
                result[key] = copy.deepcopy(value)
        return result

    def _apply_env_overrides(self) -> None:
        """从环境变量中读取配置覆盖值。

        环境变量命名规则：``PDF_EXTRACTOR_<SECTION>_<KEY>``
        例如 ``PDF_EXTRACTOR_OCR_TIMEOUT=60`` 对应 ``ocr.timeout = 60``。

        支持的类型自动转换：
        - 整数字符串 → int
        - "true"/"false"（不区分大小写）→ bool
        - 逗号分隔值 → list[str]
        - 其他 → str
        """
        for env_suffix, config_path in _ENV_KEY_MAP.items():
            env_key = _ENV_PREFIX + env_suffix
            env_value = os.environ.get(env_key)
            if env_value is not None:
                parsed = self._parse_env_value(env_value, config_path)
                if parsed is not None:
                    self._set_nested(config_path, parsed)
                    logger.debug(
                        "环境变量覆盖: %s = %s (来自 %s)",
                        config_path, parsed, env_key,
                    )

    @staticmethod
    def _parse_env_value(raw: str, config_path: str) -> Any:
        """将环境变量字符串解析为对应 Python 类型。

        Args:
            raw: 环境变量的原始字符串值。
            config_path: 对应的配置路径，用于推断目标类型。

        Returns:
            解析后的值。
        """
        # 布尔值
        if raw.lower() in ("true", "false"):
            return raw.lower() == "true"

        # 逗号分隔列表
        if "," in raw:
            return [item.strip() for item in raw.split(",")]

        # 整数（仅对已知为整数的配置项）
        integer_paths = {
            "ocr.timeout",
            "ocr.dpi",
            "performance.max_file_size_mb",
            "performance.max_pages",
            "ai_integration.max_text_length",
        }
        if config_path in integer_paths:
            try:
                return int(raw)
            except ValueError:
                logger.warning(
                    "环境变量值 '%s' 无法转换为整数 (路径: %s)，将作为字符串使用",
                    raw, config_path,
                )

        return raw

    def _set_nested(self, dotted_key: str, value: Any) -> None:
        """根据点分路径在嵌套字典中设置值。

        Args:
            dotted_key: 点分路径，例如 ``"ocr.timeout"``。
            value: 要设置的值。
        """
        keys = dotted_key.split(".")
        config = self._config
        for k in keys[:-1]:
            if k not in config or not isinstance(config[k], dict):
                config[k] = {}
            config = config[k]
        config[keys[-1]] = value

    def __repr__(self) -> str:
        return f"PDFExtractorConfig({self._config!r})"


# ---------------------------------------------------------------------------
# 缓存管理
# ---------------------------------------------------------------------------

class ExtractionCache:
    """基于 SHA256 哈希的内存缓存，用于缓存 PDF 提取结果。

    特性：
    - 线程安全（内部使用 threading.Lock）
    - 最大条目数限制（LRU 淘汰策略）
    - O(1) 的 get/put 操作

    使用示例::

        cache = ExtractionCache(max_size=128)
        cache.put("abc123", {"status": "success", ...})
        result = cache.get("abc123")
    """

    def __init__(self, max_size: int = 256) -> None:
        """初始化缓存管理器。

        Args:
            max_size: 缓存最大条目数。当缓存满时，最早插入的条目将被淘汰。
                      设为 0 可禁用缓存。
        """
        self._cache: Dict[str, Any] = {}
        self._insertion_order: List[str] = []  # 用于 LRU 淘汰
        self._lock = threading.Lock()
        self._max_size = max_size

        logger.debug("ExtractionCache 初始化，max_size=%d", max_size)

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        """从缓存中获取结果。

        Args:
            key: 缓存键（通常为 PDF 数据的 SHA256 哈希值）。

        Returns:
            缓存的提取结果字典；若缓存未命中则返回 ``None``。
        """
        if self._max_size <= 0:
            return None

        with self._lock:
            if key in self._cache:
                logger.debug("缓存命中: %s", key[:16] + "...")
                return copy.deepcopy(self._cache[key])
            logger.debug("缓存未命中: %s", key[:16] + "...")
            return None

    def put(self, key: str, result: Dict[str, Any]) -> None:
        """将提取结果存入缓存。

        当缓存已满时，会淘汰最早插入的条目（FIFO 策略）。

        Args:
            key: 缓存键（通常为 PDF 数据的 SHA256 哈希值）。
            result: 提取结果字典。
        """
        if self._max_size <= 0:
            return

        with self._lock:
            # 若 key 已存在，先移除旧记录以更新顺序
            if key in self._cache:
                self._insertion_order.remove(key)
                self._insertion_order.append(key)
                self._cache[key] = copy.deepcopy(result)
                return

            # 淘汰最早条目
            while len(self._cache) >= self._max_size:
                oldest_key = self._insertion_order.pop(0)
                del self._cache[oldest_key]
                logger.debug("缓存淘汰: %s", oldest_key[:16] + "...")

            self._cache[key] = copy.deepcopy(result)
            self._insertion_order.append(key)
            logger.debug(
                "缓存存入: %s (当前大小: %d/%d)",
                key[:16] + "...", len(self._cache), self._max_size,
            )

    def clear(self) -> None:
        """清空所有缓存条目。"""
        with self._lock:
            count = len(self._cache)
            self._cache.clear()
            self._insertion_order.clear()
            logger.debug("缓存已清空，共移除 %d 条记录", count)

    @property
    def size(self) -> int:
        """返回当前缓存条目数。"""
        with self._lock:
            return len(self._cache)

    def __repr__(self) -> str:
        return f"ExtractionCache(size={self.size}, max_size={self._max_size})"


# ---------------------------------------------------------------------------
# 哈希计算
# ---------------------------------------------------------------------------

def calculate_hash(data: bytes) -> str:
    """计算给定数据的 SHA256 哈希值。

    Args:
        data: 待计算哈希的字节数据（通常是 PDF 原始内容）。

    Returns:
        十六进制格式的 SHA256 哈希字符串（共 64 个字符）。

    Raises:
        TypeError: 当 *data* 不是 bytes 类型时。
    """
    if not isinstance(data, bytes):
        raise TypeError(f"calculate_hash 期望 bytes 类型参数，收到 {type(data).__name__}")
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# 数据转换工具
# ---------------------------------------------------------------------------

def decode_base64_pdf(base64_string: str) -> bytes:
    """将 Base64 编码的 PDF 字符串解码为字节数据。

    支持标准 Base64 和 Data URI 格式（例如 ``data:application/pdf;base64,...``）。

    Args:
        base64_string: Base64 编码的 PDF 字符串。

    Returns:
        解码后的 PDF 字节数据。

    Raises:
        ValueError: 当输入字符串无法被正确解码时。
    """
    if not isinstance(base64_string, str):
        raise TypeError(
            f"decode_base64_pdf 期望 str 类型参数，收到 {type(base64_string).__name__}"
        )

    raw = base64_string.strip()

    # 处理 Data URI 格式: data:<mime>;base64,<payload>
    if raw.startswith("data:") and ";base64," in raw:
        raw = raw.split(";base64,", 1)[1]

    # 移除可能的空白字符
    raw = re.sub(r"\s+", "", raw)

    try:
        decoded = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise ValueError(f"Base64 解码失败: {exc}") from exc

    logger.debug("Base64 解码完成，输出 %d 字节", len(decoded))
    return decoded


def normalize_pdf_input(pdf_data: Union[bytes, str]) -> bytes:
    """将 PDF 输入数据统一规范化为 bytes 类型。

    - 若输入为 ``bytes``，直接返回。
    - 若输入为 ``str``，视为 Base64 编码并调用 :func:`decode_base64_pdf` 解码。

    Args:
        pdf_data: PDF 数据，支持 bytes 或 Base64 编码字符串。

    Returns:
        PDF 字节数据。

    Raises:
        TypeError: 当输入类型不是 bytes 或 str 时。
        ValueError: 当字符串无法被 Base64 解码时。
    """
    if isinstance(pdf_data, bytes):
        return pdf_data
    if isinstance(pdf_data, str):
        return decode_base64_pdf(pdf_data)
    raise TypeError(
        f"normalize_pdf_input 期望 bytes 或 str 类型参数，收到 {type(pdf_data).__name__}"
    )


# ---------------------------------------------------------------------------
# 文本质量评估
# ---------------------------------------------------------------------------

def assess_extraction_quality(
    text: str,
    *,
    page_count: int = 0,
    method_used: str = "",
) -> Dict[str, Any]:
    """评估提取文本的质量和置信度。

    评估维度包括：
    - 文本密度（有效字符占比）
    - 可读性（常见单词 / CJK 字符占比）
    - OCR 特征检测（若使用了 OCR）
    - 是否需要人工审核

    Args:
        text: 提取出的文本内容。
        page_count: PDF 页数（可选，用于辅助判断）。
        method_used: 使用的提取方法名称（可选）。

    Returns:
        质量评估结果字典::

            {
                "extraction_confidence": 0.85,
                "has_scanned_pages": false,
                "needs_human_review": false,
                "quality_details": {
                    "text_length": 1200,
                    "readable_ratio": 0.92,
                    "estimated_words": 350,
                    "blank_page_ratio": 0.0
                }
            }
    """
    result: Dict[str, Any] = {
        "extraction_confidence": 0.0,
        "has_scanned_pages": False,
        "needs_human_review": False,
        "quality_details": {
            "text_length": 0,
            "readable_ratio": 0.0,
            "estimated_words": 0,
            "blank_page_ratio": 0.0,
        },
    }

    if not text:
        result["needs_human_review"] = True
        logger.debug("文本质量评估: 空文本，置信度 0.0，需要人工审核")
        return result

    cleaned = text.strip()
    text_length = len(cleaned)
    result["quality_details"]["text_length"] = text_length

    # ---- 1. 有效字符占比 ----
    # 移除空白字符后计算有效字符
    non_whitespace = re.sub(r"\s+", "", cleaned)
    if not non_whitespace:
        result["needs_human_review"] = True
        logger.debug("文本质量评估: 仅含空白字符，置信度 0.0")
        return result

    alpha_numeric_cjk = re.sub(
        r"[^\w\u4e00-\u9fff\u3400-\u4dbf]", "", non_whitespace
    )
    readable_ratio = len(alpha_numeric_cjk) / len(non_whitespace)
    result["quality_details"]["readable_ratio"] = round(readable_ratio, 4)

    # ---- 2. 估算字数 ----
    # CJK 字符逐个计数，拉丁词汇按空格拆分计数
    cjk_chars = re.findall(r"[\u4e00-\u9fff\u3400-\u4dbf]", cleaned)
    latin_text = re.sub(r"[\u4e00-\u9fff\u3400-\u4dbf]", " ", cleaned)
    latin_words = [w for w in latin_text.split() if re.match(r"[a-zA-Z]", w)]
    estimated_words = len(cjk_chars) + len(latin_words)
    result["quality_details"]["estimated_words"] = estimated_words

    # ---- 3. 空白页比例 ----
    if page_count > 0:
        # 粗略按换页符分页
        pages = cleaned.split("\f")
        blank_pages = sum(1 for p in pages if not p.strip())
        blank_ratio = blank_pages / page_count
        result["quality_details"]["blank_page_ratio"] = round(blank_ratio, 4)
        if blank_ratio > 0.5:
            result["has_scanned_pages"] = True

    # ---- 4. 综合置信度计算 ----
    confidence = 0.0

    # 可读性权重 (0-0.4)
    confidence += readable_ratio * 0.4

    # 文本长度权重 (0-0.3)
    if text_length >= 100:
        confidence += 0.3
    elif text_length >= 50:
        confidence += 0.2
    elif text_length >= 10:
        confidence += 0.1

    # 字数权重 (0-0.2)
    if estimated_words >= 100:
        confidence += 0.2
    elif estimated_words >= 30:
        confidence += 0.15
    elif estimated_words >= 5:
        confidence += 0.1

    # OCR 方法惩罚 (0-0.1)
    if method_used == "ocr":
        confidence += 0.05
        result["has_scanned_pages"] = True
    elif method_used:
        confidence += 0.1

    # 限制在 [0, 1]
    confidence = min(1.0, max(0.0, confidence))
    result["extraction_confidence"] = round(confidence, 2)

    # ---- 5. 是否需要人工审核 ----
    if confidence < 0.4 or readable_ratio < 0.5:
        result["needs_human_review"] = True

    logger.debug(
        "文本质量评估: 置信度=%.2f, 可读率=%.2f, 字数=%d, 需审核=%s",
        confidence, readable_ratio, estimated_words, result["needs_human_review"],
    )

    return result


# ---------------------------------------------------------------------------
# 文本截断和摘要
# ---------------------------------------------------------------------------

def truncate_text(
    text: str,
    max_length: int = 10000,
) -> Tuple[str, bool]:
    """按 AI 最大文本长度截断文本。

    Args:
        text: 原始文本。
        max_length: 最大字符数。若 <= 0 则不截断。

    Returns:
        二元组 ``(截断后的文本, 是否被截断)``。
    """
    if not text:
        return "", False

    if max_length <= 0 or len(text) <= max_length:
        return text, False

    truncated = text[:max_length]
    logger.info("文本已截断: %d → %d 字符", len(text), max_length)
    return truncated, True


def generate_summary(text: str, max_chars: int = 500) -> str:
    """生成文本摘要（前 N 个字符）。

    在截取位置尝试在句子或段落边界处断开，以保持语义完整性。

    Args:
        text: 原始文本。
        max_chars: 摘要最大字符数。

    Returns:
        截取的摘要文本。若原文短于 *max_chars*，则直接返回原文。
    """
    if not text:
        return ""

    if len(text) <= max_chars:
        return text

    # 在截取范围内寻找最佳断句点
    snippet = text[:max_chars]

    # 优先在段落/句号处断开
    for sep in ("\n\n", "。", ".", "！", "!", "？", "?", "；", ";"):
        idx = snippet.rfind(sep)
        if idx > max_chars * 0.5:
            return snippet[: idx + len(sep)].strip()

    # 无合适断句点，直接截断
    return snippet.strip()


# ---------------------------------------------------------------------------
# 输出格式化
# ---------------------------------------------------------------------------

def format_extraction_result(
    text: str,
    page_count: int,
    extraction_time_ms: int,
    method_used: str,
    config: Optional[PDFExtractorConfig] = None,
    metadata: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    """将内部提取结果转换为统一输出格式。

    输出结构::

        {
            "status": "success|partial|error",
            "data": {
                "extracted_text": "...",
                "summary": "前500字符摘要",
                "statistics": { ... },
                "quality_indicators": { ... }
            },
            "compatibility": {
                "ai_ready": true,
                "format": "ai_analysis_v1",
                "truncated": false
            }
        }

    Args:
        text: 提取到的文本内容。
        page_count: PDF 页数。
        extraction_time_ms: 提取耗时（毫秒）。
        method_used: 实际使用的提取方法（``"pdfplumber"`` | ``"pypdf2"`` | ``"ocr"``）。
        config: 配置实例，用于获取 AI 集成参数。
        metadata: 额外的元数据（可选）。
        error: 错误信息（可选）。非空时 status 将设为 ``"error"``。

    Returns:
        统一格式的提取结果字典。
    """
    # 获取配置
    if config is None:
        config = PDFExtractorConfig()

    max_text_length = config.get("ai_integration.max_text_length", 10000)
    format_version = config.get("ai_integration.format_version", "1.0")
    include_metadata = config.get("ai_integration.include_metadata", True)

    # ---- 截断文本 ----
    final_text, was_truncated = truncate_text(text, max_text_length)

    # ---- 生成摘要 ----
    summary = generate_summary(final_text, max_chars=500)

    # ---- 统计信息 ----
    word_count = _count_words(final_text)
    statistics: Dict[str, Any] = {
        "word_count": word_count,
        "page_count": page_count,
        "extraction_time_ms": extraction_time_ms,
        "method_used": method_used,
    }
    if include_metadata and metadata:
        statistics["metadata"] = metadata

    # ---- 质量评估 ----
    quality = assess_extraction_quality(
        final_text,
        page_count=page_count,
        method_used=method_used,
    )

    # ---- 确定状态 ----
    if error:
        status = "error"
    elif was_truncated:
        status = "partial"
    elif quality.get("extraction_confidence", 0) < 0.3:
        status = "partial"
    else:
        status = "success"

    # ---- AI 兼容性 ----
    ai_ready = status != "error" and bool(final_text.strip())
    compatibility: Dict[str, Any] = {
        "ai_ready": ai_ready,
        "format": f"ai_analysis_v{format_version}",
        "truncated": was_truncated,
    }

    result: Dict[str, Any] = {
        "status": status,
        "data": {
            "extracted_text": final_text,
            "summary": summary,
            "statistics": statistics,
            "quality_indicators": {
                "has_scanned_pages": quality.get("has_scanned_pages", False),
                "extraction_confidence": quality.get("extraction_confidence", 0.0),
                "needs_human_review": quality.get("needs_human_review", False),
            },
        },
        "compatibility": compatibility,
    }

    # 错误时添加错误信息
    if error:
        result["error"] = error

    logger.info(
        "格式化完成: status=%s, text_len=%d, pages=%d, method=%s, truncated=%s",
        status, len(final_text), page_count, method_used, was_truncated,
    )

    return result


# ---------------------------------------------------------------------------
# 辅助内部函数
# ---------------------------------------------------------------------------

def _count_words(text: str) -> int:
    """统计文本中的字数（CJK 字符逐字计数 + 拉丁词汇计数）。

    Args:
        text: 待统计的文本。

    Returns:
        估算的字数。
    """
    if not text:
        return 0

    # CJK 字符逐个计数
    cjk_chars = re.findall(r"[\u4e00-\u9fff\u3400-\u4dbf]", text)

    # 移除 CJK 字符后统计拉丁词汇
    latin_text = re.sub(r"[\u4e00-\u9fff\u3400-\u4dbf]", " ", text)
    latin_words = [w for w in latin_text.split() if re.match(r"[a-zA-Z0-9]", w)]

    return len(cjk_chars) + len(latin_words)
