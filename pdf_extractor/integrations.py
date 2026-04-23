"""
PDF文本提取模块 - 集成层 (integrations.py)

提供PDF提取模块与现有AI系统的集成桥梁，包括：
- PDFToAIBridge类：桥接PDF提取模块与AI系统
- EmailAttachment数据类：邮件附件数据结构
- AnalysisResult数据类：AI分析结果数据结构

主要类:
    PDFToAIBridge: AI系统集成桥梁，处理邮件附件并调用AI分析
    EmailAttachment: 邮件附件数据类
    AnalysisResult: 分析结果数据类

示例:
    >>> from pdf_extractor.integrations import PDFToAIBridge, EmailAttachment
    >>> bridge = PDFToAIBridge(ai_model=existing_ai_model)
    >>> attachment = EmailAttachment(
    ...     filename="document.pdf",
    ...     content=pdf_bytes,
    ...     content_type="application/pdf",
    ...     size=len(pdf_bytes)
    ... )
    >>> result = await bridge.process_email_attachment("email_123", attachment)
    >>> print(result.ai_analysis)
"""

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Union

# 模块日志器
logger = logging.getLogger(__name__)

# 从core导入PDFTextExtractor
from .core import PDFTextExtractor

# 从utils导入工具函数
from .utils import calculate_hash, format_extraction_result


# ---------------------------------------------------------------------------
# 数据类定义
# ---------------------------------------------------------------------------

@dataclass
class EmailAttachment:
    """邮件附件数据类。

    封装邮件附件的基本信息，包括文件名、内容、MIME类型和文件大小。

    Attributes:
        filename: 附件文件名（包含扩展名）
        content: 附件内容的二进制数据
        content_type: MIME类型（如 "application/pdf"）
        size: 文件大小（字节数）

    Example:
        >>> attachment = EmailAttachment(
        ...     filename="report.pdf",
        ...     content=b"%PDF-1.4...",
        ...     content_type="application/pdf",
        ...     size=102400
        ... )
        >>> print(attachment.filename)
        'report.pdf'
    """
    filename: str
    content: bytes
    content_type: str
    size: int

    def __post_init__(self) -> None:
        """数据类初始化后的验证逻辑。"""
        if not self.filename:
            raise ValueError("文件名不能为空")
        if not isinstance(self.content, bytes):
            raise TypeError("content必须是bytes类型")
        if self.size < 0:
            raise ValueError("文件大小不能为负数")
        # 如果size与content长度不一致，以content实际长度为准
        actual_size = len(self.content)
        if self.size != actual_size:
            logger.debug(
                "EmailAttachment size字段(%d)与实际内容长度(%d)不一致，已修正",
                self.size, actual_size
            )
            self.size = actual_size


@dataclass
class AnalysisResult:
    """AI分析结果数据类。

    封装PDF附件经过AI分析后的完整结果，包括提取信息、AI分析结果和元数据。

    Attributes:
        email_id: 关联的邮件唯一标识
        attachment_name: 附件文件名
        extraction_result: PDF文本提取的详细结果（统一格式）
        ai_analysis: AI分析返回的结果字典
        timestamp: 处理完成的时间戳（ISO 8601格式）
        success: 整个处理流程是否成功
        error: 错误信息（成功时为None）

    Example:
        >>> result = AnalysisResult(
        ...     email_id="email_123",
        ...     attachment_name="doc.pdf",
        ...     extraction_result={"status": "success", ...},
        ...     ai_analysis={"risk_level": "low", ...},
        ...     timestamp="2024-01-15T10:30:00Z",
        ...     success=True,
        ...     error=None
        ... )
    """
    email_id: str
    attachment_name: str
    extraction_result: Dict[str, Any]
    ai_analysis: Dict[str, Any]
    timestamp: str
    success: bool
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """将结果转换为字典格式。

        Returns:
            包含所有字段的字典表示
        """
        return {
            "email_id": self.email_id,
            "attachment_name": self.attachment_name,
            "extraction_result": self.extraction_result,
            "ai_analysis": self.ai_analysis,
            "timestamp": self.timestamp,
            "success": self.success,
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# PDFToAIBridge 类
# ---------------------------------------------------------------------------

class PDFToAIBridge:
    """PDF提取模块与AI系统的集成桥梁。

    该类负责将邮件中的PDF附件提取文本后，转换为AI系统期望的输入格式，
    并调用AI模型进行分析。支持异步操作、错误处理和超时控制。

    Attributes:
        ai_model: AI模型实例（任何可调用的对象）
        config: 配置字典
        extractor: PDFTextExtractor实例
        default_timeout: AI调用的默认超时时间（秒）

    Example:
        >>> # 假设 existing_ai_model 是系统中已有的AI模型实例
        >>> bridge = PDFToAIBridge(ai_model=existing_ai_model)
        >>> result = await bridge.process_email_attachment(email_id, attachment)
        >>> if result.success:
        ...     print(f"AI分析结果: {result.ai_analysis}")
    """

    DEFAULT_AI_TIMEOUT = 60  # AI调用默认超时时间（秒）
    DEFAULT_MAX_TEXT_LENGTH = 10000  # 默认最大文本长度

    def __init__(
        self,
        ai_model: Callable,
        config: Optional[Dict[str, Any]] = None
    ) -> None:
        """初始化PDFToAIBridge实例。

        Args:
            ai_model: AI模型实例，可以是任何可调用的对象（函数、类实例等）。
                     该对象将被调用来执行AI分析。
            config: 配置字典，支持以下配置项：
                - ai_integration.max_text_length: 传递给AI的最大文本长度（默认10000）
                - ai_integration.timeout: AI调用超时时间（秒，默认60）
                - ai_integration.include_metadata: 是否包含元数据（默认True）
                - extractor.*: 传递给PDFTextExtractor的配置

        Example:
            >>> config = {
            ...     "ai_integration": {"max_text_length": 5000, "timeout": 30},
            ...     "performance": {"max_pages": 20}
            ... }
            >>> bridge = PDFToAIBridge(ai_model=my_ai, config=config)
        """
        self.ai_model = ai_model
        self.config = config or {}

        # 初始化PDF提取器
        extractor_config = self.config.get("extractor", {})
        self.extractor = PDFTextExtractor(extractor_config)

        # 提取AI集成配置
        ai_config = self.config.get("ai_integration", {})
        self.default_timeout = ai_config.get("timeout", self.DEFAULT_AI_TIMEOUT)
        self.max_text_length = ai_config.get(
            "max_text_length", self.DEFAULT_MAX_TEXT_LENGTH
        )
        self.include_metadata = ai_config.get("include_metadata", True)

        logger.debug(
            "PDFToAIBridge初始化完成: timeout=%ds, max_text_length=%d",
            self.default_timeout, self.max_text_length
        )

    async def process_email_attachment(
        self,
        email_id: str,
        attachment: EmailAttachment
    ) -> AnalysisResult:
        """处理邮件附件并传递给AI进行分析。

        完整的处理流程：
        1. 验证附件是否为PDF
        2. 使用PDFTextExtractor提取文本
        3. 将提取结果格式化为AI输入格式
        4. 调用AI模型进行分析
        5. 返回统一格式的AnalysisResult

        Args:
            email_id: 邮件唯一标识符
            attachment: 邮件附件对象（EmailAttachment类型）

        Returns:
            AnalysisResult对象，包含提取结果和AI分析结果

        Raises:
            不会抛出异常，所有错误都会被捕获并封装在AnalysisResult中

        Example:
            >>> attachment = EmailAttachment(
            ...     filename="doc.pdf",
            ...     content=pdf_bytes,
            ...     content_type="application/pdf",
            ...     size=len(pdf_bytes)
            ... )
            >>> result = await bridge.process_email_attachment("email_123", attachment)
            >>> if result.success:
            ...     print(f"分析成功: {result.ai_analysis}")
            ... else:
            ...     print(f"处理失败: {result.error}")
        """
        timestamp = datetime.utcnow().isoformat() + "Z"

        try:
            # 1. 验证是否为PDF附件
            if not self._is_pdf_attachment(attachment):
                error_msg = f"非PDF附件，无法处理: {attachment.filename}"
                logger.warning(error_msg)
                return AnalysisResult(
                    email_id=email_id,
                    attachment_name=attachment.filename,
                    extraction_result=self._create_error_extraction_result(error_msg),
                    ai_analysis={},
                    timestamp=timestamp,
                    success=False,
                    error=error_msg
                )

            logger.info(
                "开始处理邮件附件: email_id=%s, filename=%s, size=%d",
                email_id, attachment.filename, attachment.size
            )

            # 2. 提取PDF文本
            extraction_result = await self._extract_pdf_text(attachment)

            # 检查提取是否成功
            if extraction_result.get("status") == "error":
                error_msg = extraction_result.get("data", {}).get(
                    "error", "PDF文本提取失败"
                )
                logger.error("PDF提取失败: %s", error_msg)
                return AnalysisResult(
                    email_id=email_id,
                    attachment_name=attachment.filename,
                    extraction_result=extraction_result,
                    ai_analysis={},
                    timestamp=timestamp,
                    success=False,
                    error=error_msg
                )

            # 3. 格式化AI输入
            ai_input = self._format_ai_input(
                extraction_result=extraction_result,
                attachment=attachment
            )

            # 4. 调用AI模型
            ai_analysis = await self._call_ai_model(ai_input)

            logger.info(
                "邮件附件处理完成: email_id=%s, filename=%s, success=%s",
                email_id, attachment.filename, True
            )

            return AnalysisResult(
                email_id=email_id,
                attachment_name=attachment.filename,
                extraction_result=extraction_result,
                ai_analysis=ai_analysis,
                timestamp=timestamp,
                success=True,
                error=None
            )

        except asyncio.TimeoutError:
            error_msg = f"AI分析超时（超过{self.default_timeout}秒）"
            logger.error("%s: email_id=%s", error_msg, email_id)
            return AnalysisResult(
                email_id=email_id,
                attachment_name=attachment.filename,
                extraction_result=self._create_error_extraction_result(error_msg),
                ai_analysis={},
                timestamp=timestamp,
                success=False,
                error=error_msg
            )

        except Exception as e:
            error_msg = f"处理邮件附件时发生异常: {str(e)}"
            logger.exception("%s: email_id=%s", error_msg, email_id)
            return AnalysisResult(
                email_id=email_id,
                attachment_name=attachment.filename,
                extraction_result=self._create_error_extraction_result(error_msg),
                ai_analysis={},
                timestamp=timestamp,
                success=False,
                error=error_msg
            )

    def _is_pdf_attachment(self, attachment: EmailAttachment) -> bool:
        """检查附件是否为PDF文件。

        通过文件名扩展名和MIME类型双重验证。

        Args:
            attachment: 邮件附件对象

        Returns:
            如果是PDF附件返回True，否则返回False
        """
        # 检查文件名扩展名
        filename_lower = attachment.filename.lower()
        has_pdf_extension = filename_lower.endswith('.pdf')

        # 检查MIME类型
        pdf_mime_types = [
            'application/pdf',
            'application/x-pdf',
            'application/octet-stream'  # 某些系统可能使用通用类型
        ]
        has_pdf_mime = attachment.content_type.lower() in pdf_mime_types

        # 同时检查文件内容签名（PDF文件以%PDF开头）
        has_pdf_signature = (
            len(attachment.content) >= 4 and
            attachment.content[:4] == b'%PDF'
        )

        is_pdf = has_pdf_extension or has_pdf_mime or has_pdf_signature

        logger.debug(
            "PDF验证: filename=%s, extension=%s, mime=%s, signature=%s, result=%s",
            attachment.filename, has_pdf_extension, has_pdf_mime,
            has_pdf_signature, is_pdf
        )

        return is_pdf

    def _calculate_file_hash(self, content: bytes) -> str:
        """计算文件内容的SHA256哈希值。

        Args:
            content: 文件内容的二进制数据

        Returns:
            十六进制格式的SHA256哈希字符串
        """
        return hashlib.sha256(content).hexdigest()

    def _format_ai_input(
        self,
        extraction_result: Dict[str, Any],
        attachment: EmailAttachment
    ) -> Dict[str, Any]:
        """将提取结果格式化为AI系统期望的输入格式。

        构造符合AI系统期望的数据结构，包含：
        - type: 数据类型标识
        - format: 文件格式
        - content: 提取的文本内容（可能被截断）
        - metadata: 附件元数据
        - timestamp: 处理时间戳

        Args:
            extraction_result: PDF提取的统一格式结果
            attachment: 邮件附件对象

        Returns:
            AI输入格式的字典
        """
        # 提取文本内容
        extracted_text = extraction_result.get("data", {}).get("extracted_text", "")

        # 文本截断处理
        truncated = False
        if len(extracted_text) > self.max_text_length:
            extracted_text = extracted_text[:self.max_text_length]
            truncated = True
            logger.debug(
                "文本已截断: original_length=%d, truncated_length=%d",
                len(extracted_text), self.max_text_length
            )

        # 获取统计信息
        statistics = extraction_result.get("data", {}).get("statistics", {})
        method_used = statistics.get("method_used", "unknown")

        # 构造AI输入格式
        ai_input = {
            "type": "email_attachment",
            "format": "pdf",
            "content": extracted_text,
            "metadata": {
                "filename": attachment.filename,
                "size": attachment.size,
                "hash": self._calculate_file_hash(attachment.content),
                "extraction_method": method_used
            },
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }

        # 添加截断标记
        if truncated:
            ai_input["truncated"] = True
            ai_input["original_length"] = len(
                extraction_result.get("data", {}).get("extracted_text", "")
            )

        # 可选：添加更多元数据
        if self.include_metadata:
            quality_indicators = extraction_result.get("data", {}).get(
                "quality_indicators", {}
            )
            ai_input["metadata"].update({
                "page_count": statistics.get("page_count", 0),
                "word_count": statistics.get("word_count", 0),
                "extraction_confidence": quality_indicators.get(
                    "extraction_confidence", 0.0
                ),
                "has_scanned_pages": quality_indicators.get(
                    "has_scanned_pages", False
                )
            })

        logger.debug(
            "AI输入格式化完成: filename=%s, content_length=%d, method=%s",
            attachment.filename, len(extracted_text), method_used
        )

        return ai_input

    async def _call_ai_model(self, ai_input: Dict[str, Any]) -> Dict[str, Any]:
        """调用AI模型进行分析。

        支持同步和异步的AI模型调用。如果ai_model是协程函数或返回协程，
        使用await调用；否则在线程池中执行同步调用。

        Args:
            ai_input: 格式化后的AI输入数据

        Returns:
            AI分析结果字典

        Raises:
            asyncio.TimeoutError: 当AI调用超时时抛出
            Exception: AI调用过程中发生的其他异常
        """
        try:
            # 使用超时控制
            return await asyncio.wait_for(
                self._execute_ai_call(ai_input),
                timeout=self.default_timeout
            )
        except asyncio.TimeoutError:
            logger.error("AI模型调用超时（%d秒）", self.default_timeout)
            raise

    async def _execute_ai_call(self, ai_input: Dict[str, Any]) -> Dict[str, Any]:
        """执行AI模型调用的内部方法。

        Args:
            ai_input: AI输入数据

        Returns:
            AI分析结果
        """
        # 检查ai_model是否为协程函数
        if asyncio.iscoroutinefunction(self.ai_model):
            # 异步调用
            logger.debug("使用异步方式调用AI模型")
            return await self.ai_model(ai_input)

        # 检查ai_model是否为类实例（有__call__方法）
        elif hasattr(self.ai_model, '__call__'):
            call_result = self.ai_model(ai_input)
            if asyncio.iscoroutine(call_result):
                # __call__返回协程
                logger.debug("AI模型__call__返回协程，使用await")
                return await call_result
            else:
                # 同步调用，在线程池中执行
                logger.debug("AI模型为同步调用，在线程池中执行")
                loop = asyncio.get_event_loop()
                return await loop.run_in_executor(None, self.ai_model, ai_input)

        else:
            raise TypeError(
                f"ai_model必须是可调用的对象，当前类型: {type(self.ai_model)}"
            )

    async def _extract_pdf_text(
        self,
        attachment: EmailAttachment
    ) -> Dict[str, Any]:
        """异步提取PDF文本内容。

        在线程池中执行同步的PDF提取操作，避免阻塞事件循环。

        Args:
            attachment: 邮件附件对象

        Returns:
            统一格式的提取结果字典
        """
        loop = asyncio.get_event_loop()

        # 在线程池中执行同步提取
        def extract_sync():
            return self.extractor.extract(
                pdf_data=attachment.content,
                use_ocr=True,  # 启用OCR作为降级策略
                max_pages=self.config.get("extractor", {}).get(
                    "performance", {}
                ).get("max_pages", 50)
            )

        try:
            # 在线程池中执行提取
            result = await loop.run_in_executor(None, extract_sync)

            # 将core.py的结果格式化为统一输出格式
            if isinstance(result, dict):
                if "status" not in result:
                    # 需要格式化为统一格式
                    return self._format_to_unified_output(result)
                return result

            return self._create_error_extraction_result("提取结果格式异常")

        except Exception as e:
            logger.exception("PDF文本提取失败")
            return self._create_error_extraction_result(str(e))

    def _format_to_unified_output(
        self,
        extraction_result: Dict[str, Any]
    ) -> Dict[str, Any]:
        """将core.py的提取结果转换为统一输出格式。

        Args:
            extraction_result: core.py返回的提取结果

        Returns:
            统一格式的输出字典
        """
        success = extraction_result.get("success", False)
        text = extraction_result.get("text", "")
        page_count = extraction_result.get("page_count", 0)
        method = extraction_result.get("method", "unknown")
        used_ocr = extraction_result.get("used_ocr", False)
        error = extraction_result.get("error")

        # 确定状态
        if success and text:
            status = "success"
        elif success and not text:
            status = "partial"
        else:
            status = "error"

        # 计算统计信息
        word_count = len(text.split()) if text else 0

        return {
            "status": status,
            "data": {
                "extracted_text": text,
                "summary": text[:500] if text else "",
                "statistics": {
                    "word_count": word_count,
                    "page_count": page_count,
                    "extraction_time_ms": 0,  # 由调用方填充
                    "method_used": method
                },
                "quality_indicators": {
                    "has_scanned_pages": used_ocr,
                    "extraction_confidence": 0.95 if success else 0.0,
                    "needs_human_review": not success or used_ocr
                },
                "error": error
            },
            "compatibility": {
                "ai_ready": success and bool(text),
                "format": "ai_analysis_v1",
                "truncated": extraction_result.get("truncated", False)
            }
        }

    def _create_error_extraction_result(self, error_msg: str) -> Dict[str, Any]:
        """创建错误状态的提取结果。

        Args:
            error_msg: 错误信息

        Returns:
            错误状态的统一格式结果
        """
        return {
            "status": "error",
            "data": {
                "extracted_text": "",
                "summary": "",
                "statistics": {
                    "word_count": 0,
                    "page_count": 0,
                    "extraction_time_ms": 0,
                    "method_used": "none"
                },
                "quality_indicators": {
                    "has_scanned_pages": False,
                    "extraction_confidence": 0.0,
                    "needs_human_review": True
                },
                "error": error_msg
            },
            "compatibility": {
                "ai_ready": False,
                "format": "ai_analysis_v1",
                "truncated": False
            }
        }


# ---------------------------------------------------------------------------
# 便捷函数
# ---------------------------------------------------------------------------

def create_bridge(
    ai_model: Callable,
    config: Optional[Dict[str, Any]] = None
) -> PDFToAIBridge:
    """创建PDFToAIBridge实例的便捷函数。

    Args:
        ai_model: AI模型实例
        config: 配置字典

    Returns:
        PDFToAIBridge实例

    Example:
        >>> bridge = create_bridge(ai_model=my_ai_model)
        >>> result = await bridge.process_email_attachment(email_id, attachment)
    """
    return PDFToAIBridge(ai_model=ai_model, config=config)


# ---------------------------------------------------------------------------
# 模块导出
# ---------------------------------------------------------------------------

__all__ = [
    "PDFToAIBridge",
    "EmailAttachment",
    "AnalysisResult",
    "create_bridge",
]