#!/usr/bin/env python3
"""
PDF提取模块命令行接口 (cli.py)

提供Node.js调用的命令行接口，支持：
- 从文件路径提取PDF文本
- 从stdin接收base64编码的PDF数据

输出格式：标准JSON，便于Node.js解析

使用示例:
    # 从文件提取
    python cli.py --file "/path/to/document.pdf"
    
    # 从stdin接收base64数据
    echo "JVBERi0xLjQKJ..." | python cli.py --base64
    
    # 使用可选参数
    python cli.py --file "/path/to/scan.pdf" --use-ocr --ocr-languages eng chi_sim

输出JSON格式:
    {
        "success": true/false,
        "data": {
            "extracted_text": "...",
            "summary": "...",
            "statistics": {...},
            "quality_indicators": {...}
        },
        "compatibility": {
            "ai_ready": true/false,
            "format": "1.0",
            "truncated": false
        },
        "error": null or "error message"
    }
"""

import argparse
import base64
import json
import logging
import sys
from io import BytesIO
from typing import Any, Dict, Optional

# 配置日志输出到stderr，避免污染stdout的JSON输出
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='[PDF CLI] %(levelname)s: %(message)s'
)
logger = logging.getLogger(__name__)

# 导入PDF提取模块
import os
import sys as _sys

# 确保项目根目录在sys.path中，以支持直接运行cli.py
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in _sys.path:
    _sys.path.insert(0, _project_root)

try:
    from pdf_extractor import extract_pdf_content, check_dependencies
except ImportError as _e:
    # 最后的降级方案：直接导入子模块
    logger.error(f"无法导入pdf_extractor模块: {_e}")
    # 输出错误JSON并退出
    print(json.dumps({
        "success": False,
        "error": f"无法导入pdf_extractor模块: {_e}",
        "data": None,
        "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
    }, ensure_ascii=False))
    _sys.exit(1)


# 支持的图片文件扩展名
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.gif', '.webp'}


def _is_image_file(file_path: str) -> bool:
    """判断文件是否为图片类型。

    Args:
        file_path: 文件路径

    Returns:
        如果文件扩展名是图片类型返回True
    """
    ext = os.path.splitext(file_path)[1].lower()
    return ext in IMAGE_EXTENSIONS


def extract_from_file(
    file_path: str,
    use_ocr: bool = False,
    ocr_languages: Optional[list] = None,
    max_pages: int = 50
) -> Dict[str, Any]:
    """从文件路径提取PDF或图片文本。

    自动检测文件类型：
    - 如果是PDF文件，使用PDF提取流程
    - 如果是图片文件（PNG/JPEG等），使用OCR提取流程

    Args:
        file_path: PDF或图片文件路径
        use_ocr: 是否使用OCR
        ocr_languages: OCR语言列表
        max_pages: 最大处理页数

    Returns:
        提取结果字典（格式与PDF提取一致）
    """
    logger.info(f"从文件提取: {file_path}")

    # 检测文件类型
    if _is_image_file(file_path):
        logger.info(f"检测到图片文件，使用OCR提取: {file_path}")
        return extract_from_image_file(file_path, ocr_languages)

    # 默认按PDF处理
    try:
        with open(file_path, 'rb') as f:
            pdf_bytes = f.read()

        logger.info(f"读取文件成功，大小: {len(pdf_bytes)} bytes")

        result = extract_pdf_content(
            pdf_data=pdf_bytes,
            use_ocr=use_ocr,
            ocr_languages=ocr_languages,
            max_pages=max_pages
        )

        return result

    except FileNotFoundError:
        return {
            "success": False,
            "error": f"文件不存在: {file_path}",
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }
    except PermissionError:
        return {
            "success": False,
            "error": f"无权限访问文件: {file_path}",
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }
    except Exception as e:
        logger.exception(f"提取PDF时发生错误: {e}")
        return {
            "success": False,
            "error": str(e),
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }


def extract_from_image_file(
    file_path: str,
    ocr_languages: Optional[list] = None
) -> Dict[str, Any]:
    """从图片文件路径提取OCR文本。

    Args:
        file_path: 图片文件路径
        ocr_languages: OCR语言列表

    Returns:
        提取结果字典（格式与PDF提取一致）
    """
    logger.info(f"从图片文件提取OCR文本: {file_path}")

    try:
        # 导入OCRHandler
        from pdf_extractor.ocr_handler import OCRHandler

        handler = OCRHandler()
        result = handler.extract_text_from_image_file(file_path, ocr_languages)

        # 将OCR结果转换为与PDF提取一致的格式
        return _convert_ocr_result_to_standard_format(result, file_path)

    except FileNotFoundError:
        return {
            "success": False,
            "error": f"图片文件不存在: {file_path}",
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }
    except Exception as e:
        logger.exception(f"图片OCR提取时发生错误: {e}")
        return {
            "success": False,
            "error": str(e),
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }


def extract_from_image_base64(
    base64_data: str,
    ocr_languages: Optional[list] = None
) -> Dict[str, Any]:
    """从base64编码的图片数据提取OCR文本。

    Args:
        base64_data: base64编码的图片数据
        ocr_languages: OCR语言列表

    Returns:
        提取结果字典（格式与PDF提取一致）
    """
    logger.info("从base64图片数据提取OCR文本")

    try:
        from pdf_extractor.ocr_handler import OCRHandler

        # 清理base64数据
        clean_data = base64_data.strip()
        if clean_data.startswith('data:'):
            # 移除 data:image/png;base64, 前缀
            clean_data = clean_data.split(',', 1)[-1]

        # 解码base64
        image_bytes = base64.b64decode(clean_data)
        logger.info(f"Base64解码成功，图片大小: {len(image_bytes)} bytes")

        handler = OCRHandler()
        result = handler.extract_text_from_image(image_bytes, ocr_languages)

        # 将OCR结果转换为与PDF提取一致的格式
        return _convert_ocr_result_to_standard_format(result, "image_from_base64")

    except Exception as e:
        logger.exception(f"Base64图片OCR提取时发生错误: {e}")
        return {
            "success": False,
            "error": f"Base64图片处理错误: {str(e)}",
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }


def _convert_ocr_result_to_standard_format(
    ocr_result: Dict[str, Any],
    source_file: str = "unknown"
) -> Dict[str, Any]:
    """将OCR处理结果转换为与PDF提取一致的标准输出格式。

    确保输出格式与extract_pdf_content()的返回值一致，
    以便Node.js端可以使用统一的解析逻辑。

    Args:
        ocr_result: OCRHandler返回的结果字典
        source_file: 源文件名

    Returns:
        标准格式的提取结果字典
    """
    success = ocr_result.get("success", False)
    text = ocr_result.get("text", "")
    method = ocr_result.get("method", "image_ocr")
    error = ocr_result.get("error")

    # 确定状态
    if success and text:
        status = "success"
    elif success and not text:
        status = "partial"
    else:
        status = "error"

    # 获取质量指标
    quality = ocr_result.get("quality_indicators", {})
    confidence = quality.get("extraction_confidence", 0.0)

    # 构造标准格式
    result = {
        "status": status,
        "data": {
            "extracted_text": text,
            "summary": text[:500] if text else "",
            "statistics": {
                "page_count": ocr_result.get("page_count", 1),
                "pages_processed": ocr_result.get("pages_processed", 1),
                "method": method,
                "used_ocr": True,
                "truncated": False,
                "source_file": source_file,
                "original_type": "image"
            },
            "quality_indicators": {
                "has_scanned_pages": quality.get("has_scanned_pages", True),
                "extraction_confidence": confidence,
                "needs_human_review": confidence < 0.4
            }
        },
        "compatibility": {
            "ai_ready": success and bool(text),
            "format": "ai_analysis_v1",
            "truncated": False
        }
    }

    # 错误时添加错误信息
    if error:
        result["error"] = error
        result["data"]["error"] = error

    return result


def extract_from_base64(
    base64_data: str,
    use_ocr: bool = False,
    ocr_languages: Optional[list] = None,
    max_pages: int = 50
) -> Dict[str, Any]:
    """从base64编码数据提取PDF文本。
    
    Args:
        base64_data: base64编码的PDF数据
        use_ocr: 是否使用OCR
        ocr_languages: OCR语言列表
        max_pages: 最大处理页数
        
    Returns:
        提取结果字典
    """
    logger.info("从base64数据提取PDF")
    
    try:
        # 清理base64数据（移除可能的空白字符和data URL前缀）
        clean_data = base64_data.strip()
        if clean_data.startswith('data:'):
            # 移除 data:application/pdf;base64, 前缀
            clean_data = clean_data.split(',', 1)[-1]
        
        # 解码base64
        pdf_bytes = base64.b64decode(clean_data)
        logger.info(f"Base64解码成功，PDF大小: {len(pdf_bytes)} bytes")
        
        result = extract_pdf_content(
            pdf_data=pdf_bytes,
            use_ocr=use_ocr,
            ocr_languages=ocr_languages,
            max_pages=max_pages
        )
        
        return result
        
    except Exception as e:
        logger.exception(f"Base64解码或PDF提取时发生错误: {e}")
        return {
            "success": False,
            "error": f"Base64处理错误: {str(e)}",
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }


def extract_from_stdin(
    use_ocr: bool = False,
    ocr_languages: Optional[list] = None,
    max_pages: int = 50
) -> Dict[str, Any]:
    """从stdin读取base64数据并提取PDF文本。
    
    Args:
        use_ocr: 是否使用OCR
        ocr_languages: OCR语言列表
        max_pages: 最大处理页数
        
    Returns:
        提取结果字典
    """
    logger.info("从stdin读取base64数据")
    
    try:
        # 从stdin读取所有数据
        base64_data = sys.stdin.read()
        
        if not base64_data or not base64_data.strip():
            return {
                "success": False,
                "error": "stdin没有接收到数据",
                "data": None,
                "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
            }
        
        return extract_from_base64(base64_data, use_ocr, ocr_languages, max_pages)
        
    except Exception as e:
        logger.exception(f"从stdin读取数据时发生错误: {e}")
        return {
            "success": False,
            "error": f"stdin读取错误: {str(e)}",
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }


def main():
    """命令行主入口函数。"""
    parser = argparse.ArgumentParser(
        description='PDF/图片文本提取命令行工具 - 供Node.js调用',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s --file document.pdf
  %(prog)s --file scan.pdf --use-ocr
  %(prog)s --file image.png              (自动检测图片文件并执行OCR)
  %(prog)s --image image.png             (显式指定图片OCR模式)
  echo "JVBERi0xLjQK..." | %(prog)s --base64
  %(prog)s --file doc.pdf --use-ocr --ocr-languages eng chi_sim
        """
    )
    
    # 检查依赖参数
    parser.add_argument(
        '--check-deps',
        action='store_true',
        help='检查PDF提取依赖是否安装'
    )
    
    # 输入源参数（互斥组，--check-deps时不需要）
    input_group = parser.add_mutually_exclusive_group(required=False)
    input_group.add_argument(
        '--file', '-f',
        type=str,
        help='PDF或图片文件路径（自动检测类型）'
    )
    input_group.add_argument(
        '--image', '-i',
        type=str,
        help='图片文件路径（强制使用OCR模式，支持PNG/JPEG等）'
    )
    input_group.add_argument(
        '--base64', '-b',
        action='store_true',
        help='从stdin读取base64编码的PDF/图片数据'
    )
    
    # 提取选项
    parser.add_argument(
        '--use-ocr',
        action='store_true',
        help='启用OCR识别（用于扫描件PDF）'
    )
    parser.add_argument(
        '--ocr-languages',
        type=str,
        nargs='+',
        default=['eng'],
        help='OCR识别语言列表（默认: eng），如: eng chi_sim'
    )
    parser.add_argument(
        '--max-pages',
        type=int,
        default=50,
        help='最大处理页数（默认: 50）'
    )
    
    args = parser.parse_args()
    
    # 检查依赖模式
    if args.check_deps:
        deps = check_dependencies()
        result = {
            "success": True,
            "command": "check-deps",
            "dependencies": deps
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    
    # 根据输入源执行提取
    if args.image:
        # 显式指定图片OCR模式
        result = extract_from_image_file(
            file_path=args.image,
            ocr_languages=args.ocr_languages
        )
    elif args.file:
        result = extract_from_file(
            file_path=args.file,
            use_ocr=args.use_ocr,
            ocr_languages=args.ocr_languages,
            max_pages=args.max_pages
        )
    elif args.base64:
        result = extract_from_stdin(
            use_ocr=args.use_ocr,
            ocr_languages=args.ocr_languages,
            max_pages=args.max_pages
        )
    else:
        result = {
            "success": False,
            "error": "未指定输入源，请使用 --file、--image 或 --base64",
            "data": None,
            "compatibility": {"ai_ready": False, "format": "1.0", "truncated": False}
        }
    
    # 输出JSON结果到stdout
    # ensure_ascii=False 确保中文等非ASCII字符正确输出
    # 使用自定义序列化器处理numpy类型（如numpy.bool_）等非标准JSON类型
    class NumpyEncoder(json.JSONEncoder):
        def default(self, obj):
            try:
                import numpy as np
                if isinstance(obj, (np.bool_, np.integer)):
                    return int(obj)
                elif isinstance(obj, np.floating):
                    return float(obj)
                elif isinstance(obj, np.ndarray):
                    return obj.tolist()
            except ImportError:
                pass
            return super().default(obj)

    output = json.dumps(result, ensure_ascii=False, cls=NumpyEncoder)
    print(output)


if __name__ == '__main__':
    main()
