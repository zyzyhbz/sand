const express = require('express');
const router = express.Router();
const fs = require('fs');
const attachmentExtractor = require('../services/attachmentExtractor');
const AIService = require('../services/aiService');

/**
 * 附件分析路由
 * 处理EML文件附件提取和AI分析
 */

// AIService已经作为单例导出,直接使用

/**
 * 提取EML文件附件并进行分析
 * POST /api/attachment/extract
 */
router.post('/extract', async (req, res) => {
    try {
        const { emlFilePath } = req.body;

        if (!emlFilePath) {
            return res.status(400).json({
                error: 'EML文件路径不能为空',
                message: '缺少参数: emlFilePath'
            });
        }

        console.log(`[附件路由] 开始提取附件: ${emlFilePath}`);
        console.log(`[附件路由] 文件是否存在: ${fs.existsSync(emlFilePath)}`);

        // 提取附件
        console.log(`[附件路由] 调用 attachmentExtractor.extractAttachments...`);
        const attachments = await attachmentExtractor.extractAttachments(emlFilePath);
        console.log(`[附件路由] extractAttachments 返回结果:`, attachments);
        console.log(`[附件路由] 附件数组长度:`, attachments ? attachments.length : 'attachments is null/undefined');

        if (!attachments || attachments.length === 0) {
            return res.json({
                success: true,
                message: '未发现附件',
                attachments: []
            });
        }

        console.log(`[附件路由] 提取到 ${attachments.length} 个附件`);

        // 对每个附件进行分析
        const analyzedAttachments = [];

        for (const attachment of attachments) {
            console.log(`[附件路由] 分析附件: ${attachment.filename}, 类型: ${attachment.contentType}`);

            const attachmentAnalysis = {
                filename: attachment.filename,
                contentType: attachment.contentType,
                size: attachment.size,
                filePath: attachment.filePath,
                extractedText: attachment.extractedText || '',
                fileType: detectAttachmentType(attachment.contentType),
                risk: 'low'
            };

            // 如果提取了文本内容,进行AI分析
            if (attachment.extractedText && attachment.extractedText.length > 0) {
                try {
                    console.log(`[附件路由] 开始AI分析附件内容, 文本长度: ${attachment.extractedText.length}`);

                    const aiPrompt = buildAttachmentAnalysisPrompt(attachment.extractedText, attachment.filename, attachment.contentType);
                    const aiAnalysis = await aiService.chat(
                        `attachment-${Date.now()}`,  // 使用唯一的会话ID
                        aiPrompt,
                        {
                            attachmentInfo: attachmentAnalysis
                        }
                    );

                    attachmentAnalysis.aiAnalysis = aiAnalysis.message || 'AI分析完成';
                    attachmentAnalysis.risk = assessAttachmentRisk(attachmentAnalysis.aiAnalysis);

                    console.log(`[附件路由] AI分析完成, 风险: ${attachmentAnalysis.risk}`);
                } catch (aiError) {
                    console.error(`[附件路由] AI分析失败:`, aiError);
                    attachmentAnalysis.aiError = aiError.message || 'AI分析失败';
                }
            }

            analyzedAttachments.push(attachmentAnalysis);
        }

        res.json({
            success: true,
            emlFile: emlFilePath,
            attachments: analyzedAttachments,
            totalAttachments: analyzedAttachments.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[附件路由] 提取附件失败:', error);
        res.status(500).json({
            error: '提取附件失败',
            message: error.message
        });
    }
});

/**
 * 附件AI深度分析
 * POST /api/attachment/analyze
 */
router.post('/analyze', async (req, res) => {
    try {
        const { attachmentContent, attachmentFilename, attachmentType } = req.body;

        if (!attachmentContent || !attachmentFilename) {
            return res.status(400).json({
                error: '附件内容和文件名不能为空',
                message: '缺少必要参数'
            });
        }

        console.log(`[附件路由] 开始深度分析附件: ${attachmentFilename}`);

        // 构建AI分析提示
        const prompt = buildDeepAttachmentAnalysisPrompt(
            attachmentContent,
            attachmentFilename,
            attachmentType
        );

        // 调用AI进行分析
        const analysis = await aiService.chat(
            `attachment-deep-${Date.now()}`,
            prompt,
            {
                attachmentContext: {
                    filename: attachmentFilename,
                    type: attachmentType,
                    contentLength: attachmentContent.length
                }
            }
        );

        res.json({
            success: true,
            analysis: analysis.message || '分析完成',
            attachmentInfo: {
                filename: attachmentFilename,
                type: attachmentType,
                riskAssessment: analyzeAttachmentRisks(analysis.message || ''),
                suggestions: generateAttachmentSuggestions(analysis.message || '')
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[附件路由] 深度分析失败:', error);
        res.status(500).json({
            error: '深度分析失败',
            message: error.message
        });
    }
});

/**
 * 构建附件分析提示词
 */
function buildAttachmentAnalysisPrompt(extractedText, filename, contentType) {
    // 根据文件类型生成特定的分析指导
    const ext = filename.toLowerCase();
    let fileTypeGuidance = '';

    if (ext.endsWith('.pdf')) {
        fileTypeGuidance = `
4. 如果是PDF文件:
   - PDF中是否包含可疑的超链接或嵌入的JavaScript?
   - 文档内容是否包含钓鱼信息或社会工程学攻击特征?
   - 是否包含敏感个人信息(身份证号、银行卡号等)?
   - PDF是否可能携带恶意payload或利用漏洞?`;
    } else if (ext.endsWith('.pptx') || contentType.includes('pptx')) {
        fileTypeGuidance = `
4. 如果是PPTX文件,幻灯片内容是否合理?是否包含可疑的宏或嵌入对象?`;
    } else if (ext.endsWith('.docx') || ext.endsWith('.doc')) {
        fileTypeGuidance = `
4. 如果是Word文档,是否包含可疑的宏、嵌入对象或外部链接?`;
    } else {
        fileTypeGuidance = `
4. 文件内容是否与声明的文件类型一致?是否存在伪装?`;
    }

    return `请分析以下附件内容,该文件来自EML邮件附件:

文件名: ${filename}
文件类型: ${contentType}
提取的文本内容:
${extractedText.substring(0, 8000)}

请从安全角度分析:
1. 内容中是否包含可疑的URL、链接或网络请求?
2. 是否包含敏感信息(如密码、密钥、邮箱等)?
3. 内容是否正常,是否包含混淆代码或恶意脚本?
${fileTypeGuidance}

请以结构化JSON格式返回分析结果,包含以下字段:
- riskLevel: "low" | "medium" | "high" | "critical"
- findings: ["发现的问题1", "发现的问题2", ...]
- summary: "简要总结"
- suspiciousElements: { urls: [], sensitiveInfo: [], other: [] }`;
}

/**
 * 构建深度附件分析提示词
 */
function buildDeepAttachmentAnalysisPrompt(content, filename, contentType) {
    return `请对以下EML邮件附件进行深度安全分析:

文件名: ${filename}
文件类型: ${contentType}

完整提取内容:
${content}

请进行全面的威胁评估:
1. 附件类型和内容是否匹配?
2. 是否包含恶意软件特征?
3. 是否包含可疑的宏或脚本?
4. 如果是文档,内容是否包含钓鱼链接?
5. 是否包含敏感数据或凭证?
6. 文件结构是否异常?

请提供详细的安全评估和建议。`;
}

/**
 * 检测附件类型
 */
function detectAttachmentType(contentType) {
    const type = contentType.toLowerCase();

    if (type.includes('pptx')) return 'PPTX (PowerPoint演示文稿)';
    if (type.includes('docx')) return 'DOCX (Word文档)';
    if (type.includes('xlsx')) return 'XLSX (Excel表格)';
    if (type.includes('pdf')) return 'PDF (PDF文档)';
    if (type.includes('zip')) return 'ZIP (压缩文件)';
    if (type.includes('exe') || type.includes('application/x-executable')) return 'EXE (可执行文件)';
    if (type.includes('jpg') || type.includes('jpeg') || type.includes('png')) return 'IMAGE (图像文件)';
    if (type.includes('text/plain')) return 'TEXT (纯文本)';

    return type;
}

/**
 * 评估附件风险
 */
function assessAttachmentRisk(aiAnalysis) {
    const analysis = aiAnalysis.toLowerCase();

    if (analysis.includes('critical') || analysis.includes('高危') || analysis.includes('严重威胁')) {
        return 'critical';
    }
    if (analysis.includes('high') || analysis.includes('高风险') || analysis.includes('恶意')) {
        return 'high';
    }
    if (analysis.includes('medium') || analysis.includes('中等风险') || analysis.includes('可疑')) {
        return 'medium';
    }

    return 'low';
}

/**
 * 分析附件风险
 */
function analyzeAttachmentRisks(analysis) {
    const risks = {
        hasSuspiciousLinks: false,
        hasMaliciousContent: false,
        hasSensitiveInfo: false,
        hasPhishing: false,
        hasObfuscatedCode: false
    };

    const keywords = {
        suspicious: ['可疑', 'suspicious', 'phishing', '钓鱼', '恶意', 'malware'],
        sensitive: ['password', '密码', 'password', 'token', 'secret', '密钥', 'key'],
        obfuscated: ['混淆', 'obfuscat', 'encoded', '编码'],
        links: ['link', '链接', 'url', 'http', 'https']
    };

    if (keywords.suspicious.some(kw => analysis.includes(kw))) {
        risks.hasMaliciousContent = true;
    }

    if (keywords.sensitive.some(kw => analysis.includes(kw))) {
        risks.hasSensitiveInfo = true;
    }

    if (keywords.phishing.some(kw => analysis.includes(kw)) || analysis.toLowerCase().includes('phishing')) {
        risks.hasPhishing = true;
    }

    if (keywords.obfuscated.some(kw => analysis.includes(kw))) {
        risks.hasObfuscatedCode = true;
    }

    if (keywords.links.some(kw => analysis.toLowerCase().includes(kw))) {
        risks.hasSuspiciousLinks = true;
    }

    return risks;
}

/**
 * 生成附件处理建议
 */
function generateAttachmentSuggestions(analysis) {
    const suggestions = [];
    const lowerAnalysis = analysis.toLowerCase();

    if (lowerAnalysis.includes('恶意') || lowerAnalysis.includes('malware')) {
        suggestions.push('🚨 检测到恶意软件特征,建议立即隔离文件');
        suggestions.push('🔒 不要打开附件,联系发件人确认');
    }

    if (lowerAnalysis.includes('钓鱼') || lowerAnalysis.includes('phishing')) {
        suggestions.push('⚠️ 疑似钓鱼附件,不要点击其中的链接');
        suggestions.push('📧 验证发件人身份');
    }

    if (lowerAnalysis.includes('密码') || lowerAnalysis.includes('password')) {
        suggestions.push('🔐 包含敏感信息,小心处理');
        suggestions.push('🚫 不要在邮件中泄露密码或凭证');
    }

    if (lowerAnalysis.includes('链接') || lowerAnalysis.includes('link')) {
        suggestions.push('🔗 检查链接的真实来源');
        suggestions.push('🌐 不要直接点击,手动输入URL');
    }

    if (!lowerAnalysis.includes('风险') && !lowerAnalysis.includes('suspicious') && !lowerAnalysis.includes('威胁')) {
        suggestions.push('✓ 未发现明显威胁,但建议保持警惕');
    }

    return suggestions;
}

module.exports = router;
