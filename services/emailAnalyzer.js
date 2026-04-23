const fs = require('fs');
const path = require('path');

/**
 * 邮件分析服务类 - 用于分析EML文件
 */
class EmailAnalyzer {
    constructor() {
        this.uploadDir = process.env.UPLOAD_DIR || './uploads';
        this.extractDir = process.env.EMAIL_EXTRACT_DIR || './email-extracts';

        // 确保提取目录存在
        if (!fs.existsSync(this.extractDir)) {
            fs.mkdirSync(this.extractDir, { recursive: true });
        }
    }

    /**
     * 分析EML文件
     * @param {string} filePath - EML文件路径
     * @returns {Promise<Object>} 分析结果
     */
    async analyzeEmail(filePath) {
        try {
            const emlContent = fs.readFileSync(filePath, 'utf8');

            // 解析EML文件
            const emailData = this.parseEML(emlContent);

            // 提取附件
            const attachments = await this.extractAttachments(emailData, filePath);

            // 生成分析报告
            const analysisResult = {
                success: true,
                emailInfo: {
                    subject: emailData.subject || '无主题',
                    from: emailData.from || '未知发件人',
                    to: emailData.to || '未知收件人',
                    date: emailData.date || '未知日期',
                    messageId: emailData.messageId || '无消息ID',
                    textContent: emailData.textContent || '', // 添加解码后的文本内容
                    contentType: emailData.contentType || '未知' // 添加内容类型
                },
                attachments: attachments,
                securityFlags: this.analyzeSecurity(emailData, attachments),
                rawContent: emlContent.substring(0, 5000) // 限制原始内容长度
            };

            return analysisResult;

        } catch (error) {
            console.error('邮件分析失败:', error);
            return {
                success: false,
                error: error.message,
                emailInfo: {},
                attachments: [],
                securityFlags: {
                    hasSuspiciousContent: true,
                    hasAttachments: false,
                    riskLevel: 'high',
                    warnings: ['邮件解析失败，可能为恶意文件']
                }
            };
        }
    }

    /**
     * 解析EML文件内容
     * @param {string} content - EML文件内容
     * @returns {Object} 解析后的邮件数据
     */
    parseEML(content) {
        const emailData = {
            headers: {},
            body: '',
            attachments: []
        };

        try {
            // 分离头部和主体
            const parts = content.split(/\r?\n\r?\n/);
            if (parts.length < 2) {
                throw new Error('无效的EML文件格式');
            }

            const headerSection = parts[0];
            const bodySection = parts.slice(1).join('\n\n');

            // 解析头部
            const lines = headerSection.split(/\r?\n/);
            for (let line of lines) {
                const colonIndex = line.indexOf(':');
                if (colonIndex > 0) {
                    const key = line.substring(0, colonIndex).trim().toLowerCase();
                    const value = line.substring(colonIndex + 1).trim();

                    // 标准化头部字段
                    switch (key) {
                        case 'from':
                            emailData.from = value;
                            break;
                        case 'to':
                            emailData.to = value;
                            break;
                        case 'subject':
                            emailData.subject = value;
                            break;
                        case 'date':
                            emailData.date = value;
                            break;
                        case 'message-id':
                            emailData.messageId = value;
                            break;
                        case 'content-type':
                            emailData.contentType = value;
                            break;
                    }

                    emailData.headers[key] = value;
                }
            }

            emailData.body = bodySection;

            // 检查是否为MIME格式（包含附件）
            if (emailData.contentType && emailData.contentType.includes('multipart')) {
                emailData.hasAttachments = true;
                emailData.mimeParts = this.parseMimeParts(bodySection, emailData.contentType);

                // 从MIME部分中提取正文内容（text/html或text/plain）
                // 优先使用text/html,其次是text/plain
                let textContent = null;
                let htmlContent = null;

                if (emailData.mimeParts && emailData.mimeParts.length > 0) {
                    for (const part of emailData.mimeParts) {
                        const contentType = part.contentType.toLowerCase();

                        // 提取text/html内容
                        if (!htmlContent && contentType.includes('text/html')) {
                            htmlContent = this.decodeQuotedPrintable(part.body);
                        }

                        // 提取text/plain内容
                        if (!textContent && contentType.includes('text/plain')) {
                            textContent = this.decodeQuotedPrintable(part.body);
                        }
                    }
                }

                // 使用HTML内容或纯文本内容作为可分析的主体
                emailData.textContent = htmlContent || textContent || bodySection;
            } else if (emailData.contentType) {
                // 非MIME格式，但是单一content-type的邮件
                // 解码quoted-printable编码的body
                emailData.textContent = this.decodeQuotedPrintable(bodySection);
            } else {
                // 没有content-type信息，直接使用body
                emailData.textContent = bodySection;
            }

        } catch (error) {
            console.error('EML解析失败:', error);
            throw new Error(`EML文件解析失败: ${error.message}`);
        }

        return emailData;
    }

    /**
     * 解析MIME部分 - 改进版本,支持复杂MIME结构
     * 支持multipart/alternative(文本和HTML版本),multipart/mixed(附件),multipart/related(HTML内嵌图片)
     * @param {string} body - 邮件主体
     * @param {string} contentType - 内容类型
     * @param {number} depth - 递归深度(防止无限递归)
     * @returns {Array} MIME部分数组
     */
    parseMimeParts(body, contentType, depth = 0) {
        // 防止无限递归
        if (depth > 10) {
            console.warn('MIME递归深度超过限制', depth);
            return [];
        }

        const parts = [];

        try {
            // 提取边界字符串 - 支持引号和无引号格式
            let boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
            if (!boundaryMatch) {
                boundaryMatch = contentType.match(/boundary="([^"]+)"/i);
            }
            if (!boundaryMatch) {
                return parts;
            }

            const boundary = '--' + boundaryMatch[1].replace(/^['"]|['"]$/g, '');
            const boundaryRegex = new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            const mimeSections = body.split(boundaryRegex);

            for (let section of mimeSections) {
                section = section.trim();

                // 跳过空section和结束标记
                if (!section || section === '--' || section.startsWith('--' + boundaryMatch[1].replace(/^['"]|['"]$/g, '') + '--')) {
                    continue;
                }

                const partLines = section.split(/\r?\n/);
                let headerEnd = -1;

                // 找到头部结束位置(空行)
                for (let i = 0; i < partLines.length; i++) {
                    if (partLines[i] === '') {
                        headerEnd = i;
                        break;
                    }
                }

                if (headerEnd > 0) {
                    const partHeaders = {};

                    // 解析头部(支持多行头部)
                    for (let i = 0; i < headerEnd; i++) {
                        let line = partLines[i];
                        // 处理行续(以空格或tab开头的行)
                        while (i + 1 < headerEnd && (partLines[i + 1].startsWith(' ') || partLines[i + 1].startsWith('\t'))) {
                            i++;
                            line += partLines[i].trim();
                        }

                        const colonIndex = line.indexOf(':');
                        if (colonIndex > 0) {
                            const key = line.substring(0, colonIndex).trim().toLowerCase();
                            const value = line.substring(colonIndex + 1).trim();
                            partHeaders[key] = value;
                        }
                    }

                    const partBody = partLines.slice(headerEnd + 1).join('\n');
                    const partContentType = partHeaders['content-type'] || '';

                    // 检查是否为嵌套的multipart结构
                    const isMultipart = partContentType.toLowerCase().includes('multipart/');
                    const isAttachment = this.isAttachment(partHeaders);

                    if (isMultipart && !isAttachment) {
                        // 递归解析嵌套的multipart结构
                        const nestedParts = this.parseMimeParts(partBody, partContentType, depth + 1);
                        parts.push(...nestedParts);
                    } else {
                        // 提取charset信息
                        const charsetMatch = partContentType.match(/charset=([^\s;"]+)/i);
                        const charset = charsetMatch ? charsetMatch[1].replace(/['"]/g, '') : 'utf-8';

                        // 处理不同的内容编码
                        let decodedBody = partBody;
                        const contentTransferEncoding = (partHeaders['content-transfer-encoding'] || '').toLowerCase();

                        if (contentTransferEncoding === 'base64') {
                            decodedBody = this.decodeBase64(partBody);
                        } else if (contentTransferEncoding === 'quoted-printable') {
                            decodedBody = this.decodeQuotedPrintable(partBody);
                        }

                        // 创建part对象
                        const part = {
                            headers: partHeaders,
                            body: decodedBody,
                            contentType: partContentType,
                            contentDisposition: partHeaders['content-disposition'] || '',
                            contentTransferEncoding: contentTransferEncoding,
                            charset: charset,
                            isAttachment: isAttachment,
                            filename: this.extractFilename(partHeaders['content-disposition'] || partHeaders['content-name'] || '')
                        };

                        // 如果是附件,调用analyzeAttachmentContent分析其内容
                        if (isAttachment) {
                            const analyzedAttachment = this.analyzeAttachmentContent(part);
                            // 将分析结果合并到part中
                            part.contentAnalyzed = analyzedAttachment.contentAnalyzed;
                            part.urlsFound = analyzedAttachment.urlsFound;
                            part.hash = analyzedAttachment.hash;
                            part.analysisError = analyzedAttachment.error;
                        }

                        parts.push(part);
                    }
                }
            }
        } catch (error) {
            console.error('MIME解析失败:', error);
            if (error.stack) console.error('错误堆栈:', error.stack);
        }

        return parts;
    }

    /**
     * 解码base64编码的内容
     * @param {string} text - base64编码的文本
     * @returns {string} 解码后的文本
     */
    decodeBase64(text) {
        try {
            return Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf-8');
        } catch (error) {
            console.error('Base64解码失败:', error);
            return text;
        }
    }

    /**
     * 解码quoted-printable编码
     * 将quoted-printable编码转换为纯文本
     * @param {string} text - quoted-printable编码的文本
     * @returns {string} 解码后的文本
     */
    decodeQuotedPrintable(text) {
        if (!text) return '';

        return text
            // 解码换行符 (=0D=0A 或 =0A)
            .replace(/=0D=0A/gi, '\n')
            .replace(/=0A/gi, '\n')
            // 解码等号 (=3D -> =)
            .replace(/=3D/g, '=')
            // 解码空格 (=20 -> space)
            .replace(/=20/g, ' ')
            // 解码tab (=09 -> tab)
            .replace(/=09/g, '\t')
            // 解码所有其他十六进制编码 (例如=2C -> ,, =3F -> ?)
            .replace(/=([0-9A-Fa-f]{2})/g, (match, hex) => {
                return String.fromCharCode(parseInt(hex, 16));
            })
            // 移除行尾的软换行符 (= 后面紧跟换行)
            .replace(/=\r?\n/g, '')
            // 移除孤立的等号（可能是格式错误）
            .replace(/(?<!=[0-9A-Fa-f]{2})=$/g, '');
    }

    /**
     * 判断是否为附件
     * @param {Object} headers - MIME头部
     * @returns {boolean}
     */
    isAttachment(headers) {
        const contentDisposition = headers['content-disposition'] || '';
        return contentDisposition.includes('attachment') ||
            contentDisposition.includes('filename=');
    }

    /**
     * 从HTML内容中提取URL
     * 从href、src、data-*等HTML属性中提取所有URL
     * @param {string} htmlContent - HTML内容
     * @returns {Array} URL数组
     */
    extractUrlsFromHTML(htmlContent) {
        if (!htmlContent || typeof htmlContent !== 'string') {
            return [];
        }

        const urls = new Set();

        // 1. 提取href属性中的URL
        const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
        let match;
        while ((match = hrefRegex.exec(htmlContent)) !== null) {
            const url = match[1].trim();
            if (this.isValidURL(url)) {
                urls.add(url);
            }
        }

        // 2. 提取src属性中的URL
        const srcRegex = /src\s*=\s*["']([^"']+)["']/gi;
        while ((match = srcRegex.exec(htmlContent)) !== null) {
            const url = match[1].trim();
            if (this.isValidURL(url)) {
                urls.add(url);
            }
        }

        // 3. 提取data-*属性中的URL (如data-url, data-href)
        const dataAttrRegex = /data-(?:url|href|src)\s*=\s*["']([^"']+)["']/gi;
        while ((match = dataAttrRegex.exec(htmlContent)) !== null) {
            const url = match[1].trim();
            if (this.isValidURL(url)) {
                urls.add(url);
            }
        }

        // 4. 提取onclick、onload等事件中的URL
        const eventRegex = /(?:onclick|onload|onerror)\s*=\s*["'][^"']*(https?:\/\/[^"']+)["']/gi;
        while ((match = eventRegex.exec(htmlContent)) !== null) {
            const url = match[1].trim();
            if (this.isValidURL(url)) {
                urls.add(url);
            }
        }

        // 5. 提取action属性中的URL (表单提交URL)
        const actionRegex = /action\s*=\s*["']([^"']+)["']/gi;
        while ((match = actionRegex.exec(htmlContent)) !== null) {
            const url = match[1].trim();
            if (this.isValidURL(url)) {
                urls.add(url);
            }
        }

        return Array.from(urls);
    }

    /**
     * 验证URL是否有效
     * @param {string} url - URL字符串
     * @returns {boolean}
     */
    isValidURL(url) {
        if (!url || typeof url !== 'string') {
            return false;
        }

        // 跳过空URL、javascript:、mailto:、tel:等协议
        if (url === '' ||
            url.startsWith('javascript:') ||
            url.startsWith('mailto:') ||
            url.startsWith('tel:') ||
            url.startsWith('#') ||
            url.startsWith('data:image/')) {
            return false;
        }

        // 验证是否为http或https协议
        return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('www.');
    }

    /**
     * 计算文件内容的哈希值
     * @param {string} content - 文件内容
     * @returns {string} SHA-256哈希值
     */
    calculateHash(content) {
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * 分析附件内容,提取其中的URL
     * @param {Object} part - MIME部分
     * @returns {Object} 分析结果
     */
    analyzeAttachmentContent(part) {
        const result = {
            filename: part.filename,
            contentType: part.contentType,
            isAttachment: part.isAttachment,
            contentAnalyzed: false,
            urlsFound: [],
            hash: null,
            size: 0,
            error: null
        };

        // 定义文本类型白名单
        const textContentTypes = [
            'text/plain',
            'text/html',
            'text/xml',
            'application/xml',
            'text/csv',
            'application/json',
            'application/javascript',
            'application/x-javascript'
        ];

        // 定义二进制类型白名单
        const binaryContentTypes = [
            'image/',
            'application/pdf',
            'application/msword',
            'application/vnd',
            'application/zip',
            'application/rar',
            'application/x-zip-compressed',
            'application/x-rar-compressed',
            'application/octet-stream'
        ];

        try {
            result.size = part.body ? part.body.length : 0;

            // 步骤1: 跳过过大的附件(超过10MB)
            if (result.size > 10 * 1024 * 1024) {
                result.contentAnalyzed = false;
                result.error = '附件过大(>10MB),跳过分析';
                return result;
            }

            // 步骤2: 识别附件类型
            const contentType = part.contentType.toLowerCase();
            const isTextType = textContentTypes.some(type => contentType.includes(type));
            const isBinaryType = binaryContentTypes.some(type => contentType.includes(type));

            // 步骤3: 处理文本类型附件(直接读取内容并扫描URL)
            if (isTextType) {
                console.log(`[附件分析] 处理文本类型附件: ${result.filename}`);

                result.contentAnalyzed = true;

                if (contentType.includes('text/html')) {
                    // HTML附件使用extractUrlsFromHTML方法
                    result.urlsFound = this.extractUrlsFromHTML(part.body);
                    console.log(`[附件分析] HTML附件提取到 ${result.urlsFound.length} 个URL`);
                } else {
                    // 其他文本类型(纯文本、XML、CSV、JSON、JS)直接使用正则搜索URL
                    const urlRegex = /https?:\/\/[^\s'"<>]+/gi;
                    const matches = part.body.match(urlRegex) || [];
                    result.urlsFound = matches;
                    console.log(`[附件分析] 纯文本附件提取到 ${result.urlsFound.length} 个URL`);
                }
            }
            // 步骤4: 处理二进制类型(base64编码)
            else if (isBinaryType) {
                console.log(`[附件分析] 处理二进制类型附件: ${result.filename}`);
                result.contentAnalyzed = true;
                result.hash = this.calculateHash(part.body);
                console.log(`[附件分析] 计算哈希: ${result.hash}`);
            }
            // 步骤5: 其他类型(可能未知或文档类型)
            else {
                console.log(`[附件分析] 附件类型: ${result.filename}, 跳过深度分析`);
                result.contentAnalyzed = false;
                result.error = '不支持的附件类型进行URL分析';
            }

        } catch (error) {
            console.error(`[附件分析] 分析附件时出错: ${error.message}`);
            result.contentAnalyzed = false;
            result.error = `分析失败: ${error.message}`;
        }

        return result;
    }

    /**
     * 提取附件
     * @param {Object} emailData - 邮件数据
     * @param {string} originalFilePath - 原始EML文件路径
     * @returns {Promise<Array>} 附件信息数组
     */
    async extractAttachments(emailData, originalFilePath) {
        const attachments = [];

        if (!emailData.mimeParts || emailData.mimeParts.length === 0) {
            return attachments;
        }

        try {
            const baseName = path.basename(originalFilePath, '.eml');

            for (let i = 0; i < emailData.mimeParts.length; i++) {
                const part = emailData.mimeParts[i];

                if (part.isAttachment) {
                    try {
                        // 提取文件名
                        const filename = this.extractFilename(part.contentDisposition) ||
                            `attachment_${i + 1}`;

                        // 解码内容（简单处理）
                        let content = part.body;
                        if (part.headers['content-transfer-encoding'] === 'base64') {
                            content = Buffer.from(part.body.replace(/\s/g, ''), 'base64');
                        }

                        // 保存附件
                        const extractPath = path.join(this.extractDir, `${baseName}_${filename}`);

                        if (Buffer.isBuffer(content)) {
                            fs.writeFileSync(extractPath, content);
                        } else {
                            fs.writeFileSync(extractPath, content, 'utf8');
                        }

                        attachments.push({
                            filename: filename,
                            path: extractPath,
                            size: content.length,
                            contentType: part.contentType,
                            extracted: true
                        });

                    } catch (error) {
                        console.error(`提取附件失败 (${i}):`, error);
                        attachments.push({
                            filename: `attachment_${i + 1}`,
                            error: error.message,
                            extracted: false
                        });
                    }
                }
            }
        } catch (error) {
            console.error('附件提取失败:', error);
        }

        return attachments;
    }

    /**
     * 从Content-Disposition头部提取文件名
     * @param {string} contentDisposition - Content-Disposition头部
     * @returns {string} 文件名
     */
    extractFilename(contentDisposition) {
        if (!contentDisposition) return null;

        const filenameMatch = contentDisposition.match(/filename[*]?=([^;]+)/);
        if (filenameMatch) {
            let filename = filenameMatch[1].trim();

            // 移除引号
            if (filename.startsWith('"') && filename.endsWith('"')) {
                filename = filename.slice(1, -1);
            }

            return filename;
        }

        return null;
    }

    /**
     * 安全分析
     * @param {Object} emailData - 邮件数据
     * @param {Array} attachments - 附件列表
     * @returns {Object} 安全标志
     */
    analyzeSecurity(emailData, attachments) {
        const flags = {
            hasSuspiciousContent: false,
            hasAttachments: attachments.length > 0,
            riskLevel: 'low',
            warnings: [],
            suspiciousPatterns: []
        };

        // 检查发件人
        if (emailData.from) {
            const from = emailData.from.toLowerCase();
            if (from.includes('noreply') || from.includes('no-reply') ||
                from.includes('admin') || from.includes('service')) {
                flags.suspiciousPatterns.push('generic_sender');
            }
        }

        // 检查主题
        if (emailData.subject) {
            const subject = emailData.subject.toLowerCase();
            const suspiciousKeywords = [
                'urgent', 'immediate', 'verify', 'suspended', 'expired',
                'invoice', 'payment', 'refund', 'click here', 'confirm',
                'security', 'alert', 'warning', 'suspended'
            ];

            for (const keyword of suspiciousKeywords) {
                if (subject.includes(keyword)) {
                    flags.suspiciousPatterns.push(`keyword_${keyword}`);
                }
            }
        }

        // 检查附件
        if (attachments.length > 0) {
            const executableExtensions = ['.exe', '.scr', '.vbs', '.bat', '.cmd', '.pif', '.com'];

            for (const attachment of attachments) {
                if (attachment.filename) {
                    const ext = path.extname(attachment.filename).toLowerCase();
                    if (executableExtensions.includes(ext)) {
                        flags.suspiciousPatterns.push(`executable_attachment_${ext}`);
                    }

                    // 检查双扩展名
                    const nameWithoutExt = path.basename(attachment.filename, ext);
                    if (nameWithoutExt.includes('.')) {
                        flags.suspiciousPatterns.push('double_extension');
                    }
                }
            }
        }

        // 评估风险等级
        if (flags.suspiciousPatterns.length >= 3) {
            flags.riskLevel = 'high';
            flags.hasSuspiciousContent = true;
        } else if (flags.suspiciousPatterns.length >= 1) {
            flags.riskLevel = 'medium';
            flags.hasSuspiciousContent = true;
        }

        // 生成警告信息
        if (flags.hasAttachments && attachments.some(a => a.filename &&
            ['.exe', '.scr', '.vbs', '.bat'].includes(path.extname(a.filename).toLowerCase()))) {
            flags.warnings.push('邮件包含可执行文件附件，存在安全风险');
        }

        if (flags.suspiciousPatterns.includes('double_extension')) {
            flags.warnings.push('检测到双扩展名，可能试图隐藏文件真实类型');
        }

        if (emailData.subject && emailData.subject.toLowerCase().includes('urgent')) {
            flags.warnings.push('邮件主题包含紧急字样，可能是社会工程学攻击');
        }

        return flags;
    }

    /**
     * 获取AI分析用的详细报告
     * @param {string} filePath - EML文件路径
     * @returns {Promise<Object>} 详细分析报告
     */
    async getDetailedAnalysis(filePath) {
        const result = await this.analyzeEmail(filePath);

        if (!result.success) {
            return {
                tool: 'EmailAnalyzer',
                success: false,
                error: result.error,
                summary: '邮件分析失败',
                analysis: {
                    maliciousBehavior: [],
                    networkActivity: [],
                    fileOperations: [],
                    urls: [],
                    suspiciousPatterns: [],
                    riskLevel: 'unknown'
                }
            };
        }

        // 转换安全标志为统一的分析格式
        const analysis = {
            maliciousBehavior: [],
            networkActivity: [],
            fileOperations: [],
            urls: [],
            suspiciousPatterns: [],
            riskLevel: result.securityFlags.riskLevel || 'unknown'
        };

        // 添加恶意行为
        if (result.securityFlags.warnings && result.securityFlags.warnings.length > 0) {
            analysis.maliciousBehavior = result.securityFlags.warnings.map(warning => ({
                type: 'email_warning',
                details: warning
            }));
        }

        // 添加可疑模式
        if (result.securityFlags.suspiciousPatterns && result.securityFlags.suspiciousPatterns.length > 0) {
            analysis.suspiciousPatterns = result.securityFlags.suspiciousPatterns;
        }

        // 添加文件操作（附件）
        if (result.attachments && result.attachments.length > 0) {
            analysis.fileOperations = result.attachments.map(att => ({
                type: 'attachment',
                details: `${att.filename} (${att.size} bytes, ${att.contentType})`
            }));
        }

        // 从邮件内容中提取URL - 使用已解码的textContent (已包含text/html或text/plain内容)
        let decodedBody = result.emailInfo.textContent || result.emailInfo.body || '';
        const urlRegex = /https?:\/\/[^\s'"<>]+/gi;
        const emailUrls = decodedBody ? decodedBody.match(urlRegex) || [] : [];
        analysis.urls = [...new Set(emailUrls)]; // 去重

        return {
            tool: 'EmailAnalyzer',
            success: true,
            summary: `邮件主题: "${result.emailInfo.subject}" | 发件人: ${result.emailInfo.from} | 附件: ${result.attachments.length}个 | 风险等级: ${result.securityFlags.riskLevel}`,
            analysis: analysis,
            attachments: result.attachments.map(att => ({
                filename: att.filename,
                size: att.size,
                contentType: att.contentType,
                extracted: att.extracted,
                path: att.path
            }))
        };
    }
}

module.exports = EmailAnalyzer;