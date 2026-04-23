const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const pdfExtractorService = require('./pdfExtractorService');

/**
 * 附件提取器服务
 * 用于从EML文件中提取附件内容，特别是PPTX、PDF和图片文件（PNG/JPEG等）
 */
class AttachmentExtractor {
    constructor() {
        this.attachmentDir = path.join(__dirname, '..', 'email-extracts');
        this.ensureAttachmentDir();
    }

    /**
     * 确保附件提取目录存在
     */
    ensureAttachmentDir() {
        if (!fs.existsSync(this.attachmentDir)) {
            fs.mkdirSync(this.attachmentDir, { recursive: true });
        }
    }

    /**
     * 从EML文件中提取附件
     * @param {string} emlFilePath - EML文件路径
     * @returns {Promise<Array>} 附件信息数组
     */
    async extractAttachments(emlFilePath) {
        console.log(`[附件提取器] 开始处理EML文件: ${emlFilePath}`);

        try {
            if (!fs.existsSync(emlFilePath)) {
                throw new Error(`EML文件不存在: ${emlFilePath}`);
            }

            // 读取EML文件内容
            const emlContent = fs.readFileSync(emlFilePath, 'utf-8');

            // 解析EML文件，提取附件
            const attachments = await this.parseEMLAttachments(emlContent, emlFilePath);

            console.log(`[附件提取器] 提取到 ${attachments.length} 个附件`);
            return attachments;

        } catch (error) {
            console.error(`[附件提取器] 提取附件失败:`, error);
            return [];
        }
    }

    /**
     * 解析EML文件内容，提取附件
     * @param {string} content - EML文件内容
     * @param {string} emlFilePath - EML文件路径
     * @returns {Promise<Array>} 附件信息数组
     */
    async parseEMLAttachments(content, emlFilePath) {
        const attachments = [];
        const parts = this.splitMIMEParts(content);

        for (const part of parts) {
            const isAttachment = this.isAttachmentPart(part);
            if (isAttachment) {
                const attachmentInfo = await this.extractAttachmentContent(part, emlFilePath);
                if (attachmentInfo) {
                    attachments.push(attachmentInfo);
                }
            }
        }

        return attachments;
    }

    /**
     * 分割MIME部分
     * @param {string} content - EML内容
     * @returns {Array} MIME部分数组
     */
    splitMIMEParts(content) {
        const parts = [];
        const boundaryMatch = content.match(/boundary="([^"]+)"/i) || content.match(/boundary=([^;\s]+)/i);

        if (!boundaryMatch) {
            return [content];
        }

        const boundary = boundaryMatch[1];
        const boundaryRegex = new RegExp(`--${boundary}`, 'g');

        let lastIndex = 0;
        let match;

        while ((match = boundaryRegex.exec(content)) !== null) {
            if (lastIndex > 0) {
                const partContent = content.substring(lastIndex, match.index).trim();
                if (partContent && !partContent.startsWith('--')) {
                    parts.push(partContent);
                }
            }
            lastIndex = match.index + match[0].length;
        }

        // 处理最后一个部分
        if (lastIndex < content.length) {
            const lastPart = content.substring(lastIndex).trim();
            if (lastPart && !lastPart.startsWith('--')) {
                parts.push(lastPart);
            }
        }

        return parts;
    }

    /**
     * 判断是否为附件部分
     * @param {string} part - MIME部分
     * @returns {boolean} 是否为附件
     */
    isAttachmentPart(part) {
        const partLower = part.toLowerCase();

        // 1. 传统的附件标记
        const hasAttachmentDisposition = partLower.includes('content-disposition: attachment') ||
            partLower.includes('content-disposition: form-data');

        // 2. 内嵌图片（inline）有Content-ID
        const hasContentId = partLower.includes('content-id:');

        // 3. 有文件名（name参数）
        const hasFilename = partLower.includes('name=') || partLower.includes('filename=');

        // 4. 是图片类型或octet-stream（可能是图片）
        const isImageOrBinary = partLower.includes('content-type: image/') ||
            partLower.includes('content-type: application/octet-stream');

        // 5. 有编码（说明是二进制数据）
        const hasEncoding = partLower.includes('content-transfer-encoding:');

        // 情况1：传统附件
        if (hasAttachmentDisposition && (partLower.includes('content-type:') || hasEncoding)) {
            return true;
        }

        // 情况2：内嵌图片（有Content-ID + 是图片类型 + 有文件名）
        if (hasContentId && isImageOrBinary && hasFilename) {
            return true;
        }

        // 情况3：有文件名的二进制内容（可能是附件）
        if (hasFilename && isImageOrBinary && hasEncoding) {
            return true;
        }

        return false;
    }

    /**
     * 解码MIME RFC 2047编码的文件名
     * @param {string} filename - 编码的文件名
     * @returns {string} 解码后的文件名
     */
    decodeMimeFilename(filename) {
        if (!filename) return filename;

        // 匹配RFC 2047编码格式: =?charset?encoding?encoded-text?=
        const mimeEncodedPattern = /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g;

        return filename.replace(mimeEncodedPattern, (match, charset, encoding, encodedText) => {
            try {
                let decoded;
                if (encoding.toUpperCase() === 'B') {
                    // Base64解码
                    decoded = Buffer.from(encodedText, 'base64').toString(charset);
                } else if (encoding.toUpperCase() === 'Q') {
                    // Quoted-printable解码
                    decoded = encodedText.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (match, hex) => {
                        return String.fromCharCode(parseInt(hex, 16));
                    });
                    decoded = Buffer.from(decoded, 'binary').toString(charset);
                }
                return decoded;
            } catch (error) {
                console.warn(`[附件提取器] MIME解码失败: ${error.message}`);
                return match; // 解码失败返回原文
            }
        });
    }

    /**
     * 提取附件内容
     * @param {string} part - MIME部分
     * @param {string} emlFilePath - EML文件路径
     * @returns {Promise<Object|null>} 附件信息
     */
    async extractAttachmentContent(part, emlFilePath) {
        try {
            // 提取附件元数据 - 处理MIME折叠头（续行以空格/tab开头）
            const unfoldedPart = part.replace(/\r?\n[ \t]+/g, ' ');
            const contentTypeMatch = unfoldedPart.match(/content-type:\s*([^\r\n]+)/i);
            const contentDispositionMatch = unfoldedPart.match(/content-disposition:\s*([^\r\n]+)/i);

            const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : '';
            const contentDisposition = contentDispositionMatch ? contentDispositionMatch[1].trim() : '';

            // 提取文件名
            let filename = 'unknown-attachment';

            // 从 Content-Disposition 提取 filename
            let filenameMatch1 = null;
            let filenameMatch2 = null;
            if (contentDisposition) {
                filenameMatch1 = contentDisposition.match(/filename="([^"]+)"/i);
                filenameMatch2 = contentDisposition.match(/filename=([^;\s]+)/i);
            }

            // 从 Content-Type 提取 name（用于内嵌图片）
            const filenameMatch3 = contentType.match(/name="([^"]+)"/i);
            const filenameMatch4 = contentType.match(/name=([^;\s]+)/i);

            // 从整个MIME part的展开内容中搜索 name= 参数（兜底）
            let filenameMatch5 = null;
            let filenameMatch6 = null;
            if (filename === 'unknown-attachment') {
                filenameMatch5 = unfoldedPart.match(/name="([^"]+)"[^:]*/i);
                filenameMatch6 = unfoldedPart.match(/name=([^;\s\r\n"]+)/i);
            }

            if (filenameMatch1) filename = filenameMatch1[1];
            else if (filenameMatch2) filename = filenameMatch2[1];
            else if (filenameMatch3) filename = filenameMatch3[1];
            else if (filenameMatch4) filename = filenameMatch4[1];
            else if (filenameMatch5) filename = filenameMatch5[1];
            else if (filenameMatch6) filename = filenameMatch6[1];

            // 解码MIME编码的文件名
            filename = this.decodeMimeFilename(filename);

            // 提取附件内容（跳过头部）
            const hasCRLF = part.indexOf('\r\n\r\n') !== -1;
            const separatorIndex = hasCRLF
                ? part.indexOf('\r\n\r\n')
                : part.indexOf('\n\n');
            if (separatorIndex === -1) return null;

            // 根据 Windows 还是 Unix 换行符决定跳过的字节数
            const skipBytes = hasCRLF ? 4 : 2;
            let content = part.substring(separatorIndex + skipBytes).trim();

            // Base64解码
            // Base64解码
            content = this.base64Decode(content);

            // 根据Content-Type推断文件扩展名（如果文件名没有扩展名）
            let fileExt = path.extname(filename);
            if (!fileExt || fileExt === '') {
                // 从Content-Type推断扩展名
                if (contentType.toLowerCase().includes('image/png')) fileExt = '.png';
                else if (contentType.toLowerCase().includes('image/jpeg') || contentType.toLowerCase().includes('image/jpg')) fileExt = '.jpg';
                else if (contentType.toLowerCase().includes('image/bmp')) fileExt = '.bmp';
                else if (contentType.toLowerCase().includes('image/gif')) fileExt = '.gif';
                else if (contentType.toLowerCase().includes('image/webp')) fileExt = '.webp';
                else if (contentType.toLowerCase().includes('application/pdf')) fileExt = '.pdf';
                else if (contentType.toLowerCase().includes('application/vnd.openxmlformats-officedocument.presentationml.presentation')) fileExt = '.pptx';
                else fileExt = '.bin';

                // 给文件名添加扩展名
                filename = filename + fileExt;
            }

            // 文件魔数检测：当扩展名为.bin或不明确时，通过文件内容推断实际类型
            if (fileExt === '.bin' || !fileExt || fileExt === '') {
                if (Buffer.isBuffer(content) && content.length >= 8) {
                    // PNG: 89 50 4E 47 0D 0A 1A 0A
                    if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4E && content[3] === 0x47) {
                        fileExt = '.png';
                        console.log('[附件提取器] 通过魔数检测识别为PNG文件');
                    }
                    // JPEG: FF D8 FF
                    else if (content[0] === 0xFF && content[1] === 0xD8 && content[2] === 0xFF) {
                        fileExt = '.jpg';
                        console.log('[附件提取器] 通过魔数检测识别为JPEG文件');
                    }
                    // PDF: 25 50 44 46 (%PDF)
                    else if (content[0] === 0x25 && content[1] === 0x50 && content[2] === 0x44 && content[3] === 0x46) {
                        fileExt = '.pdf';
                        console.log('[附件提取器] 通过魔数检测识别为PDF文件');
                    }
                    // GIF: 47 49 46 38 (GIF8)
                    else if (content[0] === 0x47 && content[1] === 0x49 && content[2] === 0x46 && content[3] === 0x38) {
                        fileExt = '.gif';
                        console.log('[附件提取器] 通过魔数检测识别为GIF文件');
                    }
                    // BMP: 42 4D (BM)
                    else if (content[0] === 0x42 && content[1] === 0x4D) {
                        fileExt = '.bmp';
                        console.log('[附件提取器] 通过魔数检测识别为BMP文件');
                    }
                    // ZIP/PPTX/DOCX/XLSX: 50 4B 03 04 (PK..)
                    else if (content[0] === 0x50 && content[1] === 0x4B && content[2] === 0x03 && content[3] === 0x04) {
                        // 进一步区分 Office 文件
                        const contentStr = content.toString('utf8', 0, Math.min(2000, content.length));
                        if (contentStr.includes('ppt/')) {
                            fileExt = '.pptx';
                            console.log('[附件提取器] 通过魔数检测识别为PPTX文件');
                        } else if (contentStr.includes('word/')) {
                            fileExt = '.docx';
                            console.log('[附件提取器] 通过魔数检测识别为DOCX文件');
                        } else if (contentStr.includes('xl/')) {
                            fileExt = '.xlsx';
                            console.log('[附件提取器] 通过魔数检测识别为XLSX文件');
                        } else {
                            fileExt = '.zip';
                            console.log('[附件提取器] 通过魔数检测识别为ZIP文件');
                        }
                    }
                    // RAR: 52 61 72 21 (Rar!)
                    else if (content[0] === 0x52 && content[1] === 0x61 && content[2] === 0x72 && content[3] === 0x21) {
                        fileExt = '.rar';
                        console.log('[附件提取器] 通过魔数检测识别为RAR文件');
                    }
                    // 7z: 37 7A BC AF 27 1C
                    else if (content[0] === 0x37 && content[1] === 0x7A && content[2] === 0xBC && content[3] === 0xAF) {
                        fileExt = '.7z';
                        console.log('[附件提取器] 通过魔数检测识别为7Z文件');
                    }

                    // 如果通过魔数检测到了类型，更新文件名
                    if (fileExt !== '.bin') {
                        // 移除之前的错误扩展名（如果有）
                        const currentExt = path.extname(filename);
                        if (currentExt === '.bin' || currentExt === '') {
                            filename = path.basename(filename, currentExt) + fileExt;
                        }
                    }
                }
            }

            // 保存附件到文件
            const emlFilename = path.basename(emlFilePath, path.extname(emlFilePath));
            const savePath = path.join(this.attachmentDir, `${emlFilename}_${filename}`);

            fs.writeFileSync(savePath, content, 'binary');

            console.log(`[附件提取器] 附件已保存: ${savePath} (${content.length} 字节, 扩展名: ${fileExt})`);

            // 根据文件类型提取文本内容
            let extractedText = '';
            const extLower = fileExt.toLowerCase();
            if (extLower === '.pptx') {
                extractedText = await this.extractPPTXContent(savePath);
            } else if (extLower === '.pdf') {
                extractedText = await this.extractPDFContent(savePath);
            } else if (['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.gif', '.webp'].includes(extLower)) {
                extractedText = await this.extractImageContent(savePath);
            }
            return {
                filename: filename,
                contentType: contentType,
                filePath: savePath,
                size: content.length,
                extractedText: extractedText
            };

        } catch (error) {
            console.error(`[附件提取器] 提取附件内容失败:`, error);
            return null;
        }
    }

    /**
     * Base64解码
     * @param {string} content - Base64编码内容
     * @returns {string} 解码后的内容
     */
    base64Decode(content) {
        try {
            // 移除所有空白字符
            const cleanContent = content.replace(/\s/g, '');
            return Buffer.from(cleanContent, 'base64');
        } catch (error) {
            console.error('[附件提取器] Base64解码失败:', error);
            return content;
        }
    }

    /**
     * 从PPTX文件中提取文本内容
     * @param {string} pptxPath - PPTX文件路径
     * @returns {Promise<string>} 提取的文本内容
     */
    async extractPPTXContent(pptxPath) {
        console.log(`[附件提取器] 开始提取PPTX内容: ${pptxPath}`);

        try {
            // 使用Python脚本提取PPTX内容
            const pythonScript = `
import sys
from pptx import Presentation
import json

def extract_text_from_pptx(pptx_path):
    try:
        prs = Presentation(pptx_path)
        all_text = []
        
        for slide in prs.slides:
            slide_text = []
            for shape in slide.shapes:
                if hasattr(shape, "text"):
                    text = shape.text.strip()
                    if text:
                        slide_text.append(text)
            
            if slide_text:
                all_text.append('\\n'.join(slide_text))
        
        result = {
            'success': True,
            'content': '\\n\\n--- Slide ---\\n\\n'.join(all_text)
        }
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }, ensure_ascii=False))

if __name__ == '__main__':
    extract_text_from_pptx(sys.argv[1])
`;

            // 保存临时Python脚本
            const tempScriptPath = path.join(this.attachmentDir, 'extract_pptx.py');
            fs.writeFileSync(tempScriptPath, pythonScript, 'utf-8');

            // 执行Python脚本
            const { stdout, stderr } = await execAsync(`python "${tempScriptPath}" "${pptxPath}"`, {
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer
            });

            // 删除临时脚本
            fs.unlinkSync(tempScriptPath);

            // 解析结果
            const result = JSON.parse(stdout);

            if (result.success) {
                console.log(`[附件提取器] PPTX内容提取成功, 文本长度: ${result.content.length}`);
                return result.content;
            } else {
                console.error(`[附件提取器] PPTX内容提取失败: ${result.error}`);
                return '';
            }

        } catch (error) {
            console.error(`[附件提取器] PPTX内容提取异常:`, error);
            return '';
        }
    }

    /**
     * 从PDF文件中提取文本内容
     * 使用pdf_extractor Python模块进行提取
     /**
      * 从PDF文件中提取文本内容
      * 使用pdf_extractor Python模块进行提取
      * @param {string} pdfPath - PDF文件路径
      * @returns {Promise<string>} 提取的文本内容
      */
    async extractPDFContent(pdfPath) {
        console.log(`[附件提取器] 开始提取PDF内容: ${pdfPath}`);

        try {
            // 调用PDF提取服务
            const result = await pdfExtractorService.extractFromFile(pdfPath);

            if (result.success && result.data && result.data.extracted_text) {
                const textLength = result.data.extracted_text.length;
                console.log(`[附件提取器] PDF内容提取成功, 文本长度: ${textLength}`);

                // 如果有统计信息，记录日志
                if (result.data.statistics) {
                    const stats = result.data.statistics;
                    console.log(`[附件提取器] PDF统计: 页数=${stats.total_pages || 'N/A'}, 字符数=${stats.total_characters || 'N/A'}, 方法=${result.method || 'N/A'}`);
                }

                return result.data.extracted_text;
            } else {
                const errorMsg = result.error || '未知错误';
                console.error(`[附件提取器] PDF内容提取失败: ${errorMsg}`);

                // 尝试降级方案：直接读取PDF文件元信息
                try {
                    const fileStats = fs.statSync(pdfPath);
                    console.log(`[附件提取器] PDF降级: 文件大小 ${fileStats.size} 字节, 无法提取文本内容`);
                } catch (statError) {
                    // 忽略stat错误
                }

                return '';
            }

        } catch (error) {
            console.error(`[附件提取器] PDF内容提取异常:`, error);
            return '';
        }
    }

    /**
     * 从图片文件中提取OCR文本内容
     * 使用pdf_extractor Python模块的OCR功能进行提取
     * @param {string} imagePath - 图片文件路径（PNG/JPEG等）
     * @returns {Promise<string>} 提取的文本内容
     */
    async extractImageContent(imagePath) {
        console.log(`[附件提取器] 开始提取图片OCR内容: ${imagePath}`);

        try {
            // 调用PDF提取服务的图片OCR功能
            const result = await pdfExtractorService.extractFromImageFile(imagePath);

            // Python CLI返回的结果格式为 {status, data, compatibility, ...}
            // result.success 是 _executePython 返回的，需要同时检查 result.data
            const statusOk = result.status === 'success' || result.success;
            const extractedText = result.data?.extracted_text || result.data?.summary || '';

            if (statusOk && extractedText) {
                const textLength = extractedText.length;
                console.log(`[附件提取器] 图片OCR内容提取成功, 文本长度: ${textLength}`);

                // 如果有统计信息，记录日志
                if (result.data && result.data.statistics) {
                    const stats = result.data.statistics;
                    console.log(`[附件提取器] 图片OCR统计: 方法=${stats.method || 'N/A'}, 来源=${stats.source_file || 'N/A'}, 类型=${stats.original_type || 'N/A'}`);
                }

                return extractedText;
            } else {
                const errorMsg = result.error || (result.data ? '提取文本为空' : '未知错误');
                console.error(`[附件提取器] 图片OCR内容提取失败: ${errorMsg}`);

                // 尝试降级方案：记录图片文件元信息
                try {
                    const fileStats = fs.statSync(imagePath);
                    console.log(`[附件提取器] 图片OCR降级: 文件大小 ${fileStats.size} 字节, 无法提取文本内容`);
                } catch (statError) {
                    // 忽略stat错误
                }

                return '';
            }

        } catch (error) {
            console.error(`[附件提取器] 图片OCR内容提取异常:`, error);
            return '';
        }
    }

    /**
     * 清理提取的附件文件
     * @param {string} emlFilePath - EML文件路径
     */
    cleanupAttachments(emlFilePath) {
        try {
            const emlFilename = path.basename(emlFilePath, path.extname(emlFilePath));
            const files = fs.readdirSync(this.attachmentDir);

            for (const file of files) {
                if (file.startsWith(emlFilename)) {
                    const filePath = path.join(this.attachmentDir, file);
                    fs.unlinkSync(filePath);
                    console.log(`[附件提取器] 已清理附件文件: ${filePath}`);
                }
            }
        } catch (error) {
            console.error(`[附件提取器] 清理附件文件失败:`, error);
        }
    }

    /**
     * 批量清理所有附件文件
     */
    cleanupAllAttachments() {
        try {
            const files = fs.readdirSync(this.attachmentDir);

            for (const file of files) {
                const filePath = path.join(this.attachmentDir, file);
                const stats = fs.statSync(filePath);

                if (stats.isFile()) {
                    fs.unlinkSync(filePath);
                    console.log(`[附件提取器] 已清理附件文件: ${filePath}`);
                }
            }
        } catch (error) {
            console.error(`[附件提取器] 批量清理附件文件失败:`, error);
        }
    }
}

module.exports = new AttachmentExtractor();
