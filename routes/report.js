const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const aiReportService = require('../services/aiReportService');
const iconv = require('iconv-lite');
const pdfService = require('../services/pdfService');
const pdfBrowserService = require('../services/pdfBrowserService');
const userService = require('../services/userService');

const reportDir = path.join(__dirname, '..', 'reports');

// 确保报告目录存在
if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
}

/**
 * 获取用户专属报告目录，按需创建
 * @param {number} userId - 用户ID
 * @returns {string} 用户报告目录路径
 */
function getUserReportDir(username) {
    const userDir = path.join(reportDir, `user_${username}`);
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }
    return userDir;
}

/**
 * 查找报告文件路径 - 先查用户子目录，再查根目录（兼容旧数据）
 * @param {string} reportId - 报告ID
 * @param {number} userId - 用户ID
 * @returns {string} 报告文件路径
 */
function findReportPath(reportId, userId) {
    // 优先从用户子目录查找
    const userReportPath = path.join(getUserReportDir(userId), `${reportId}.json`);
    if (fs.existsSync(userReportPath)) {
        return userReportPath;
    }
    // 回退到根 reports 目录（兼容历史数据）
    const rootReportPath = path.join(reportDir, `${reportId}.json`);
    return rootReportPath;
}

/**
 * 生成并保存报告
 * POST /api/report/generate
 */
router.post('/generate', async (req, res) => {
    try {
        // 【关键】详细日志追踪: 检查接收到的aiReport参数
        console.log('[/api/report/generate] ===== 开始生成报告 =====');
        console.log('[/api/report/generate] req.body:', JSON.stringify(req.body, null, 2));
        console.log('[/api/report/generate] aiReport 类型:', typeof req.body.aiReport);
        console.log('[/api/report/generate] aiReport 是否为null/undefined:', req.body.aiReport === null || req.body.aiReport === undefined);
        console.log('[/api/report/generate] aiReport 长度:', req.body.aiReport ? req.body.aiReport.length : 0);
        console.log('[/api/report/generate] aiReport 前200字符:', req.body.aiReport ? req.body.aiReport.substring(0, 200) : '无内容');

        const { analysisData, fileInfo, aiReport } = req.body;

        if (!analysisData || !fileInfo) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        // 生成报告ID - 使用原始文件名 + 时间戳，确保唯一性
        let originalFilename = fileInfo.originalName || fileInfo.filename || 'unknown-file';
        let displayFilename = originalFilename; // 用于显示的文件名（保持原始中文）

        // 尝试修复中文文件名编码问题（如果文件名是URL编码的）
        try {
            // 检查是否是URL编码的格式（如 E5_85_B8_E5_9E_8B）
            if (/E[0-9A-F]{2}_/i.test(originalFilename)) {
                // 尝试解码URL编码的文件名
                const urlDecoded = decodeURIComponent(originalFilename.replace(/_/g, '%'));
                if (urlDecoded !== originalFilename) {
                    console.log('[报告生成] URL编码文件名已解码:', urlDecoded);
                    displayFilename = urlDecoded;
                }
            }
            // 检查是否是二进制编码的中文
            else if (/[^\x00-\x7F]/.test(originalFilename)) {
                const decoded = iconv.decode(Buffer.from(originalFilename, 'binary'), 'utf8');
                if (/[^\x00-\x7F]/.test(decoded) && decoded !== originalFilename) {
                    displayFilename = decoded;
                    console.log('[报告生成] 文件名编码已修复:', displayFilename);
                }
            }
        } catch (e) {
            console.log('[报告生成] 文件名编码修复失败:', e.message);
        }

        // 清理文件名用于reportId（只保留ASCII字符以确保文件系统兼容）
        const safeFilename = displayFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const reportId = `report-${safeFilename}-${Date.now()}`;
        const userReportDir = getUserReportDir(req.user.username);
        const reportPath = path.join(userReportDir, `${reportId}.json`);
        console.log(`[报告生成] reportId="${reportId}", reportPath="${reportPath}", userId="${req.user.id}"`);

        // 仅使用前端传入的 aiReport；JSON 报告本身不强依赖 AI，避免生成阶段失败
        const finalAiReport = aiReport || null;
        console.log('[/api/report/generate] finalAiReport 已设置, 类型:', typeof finalAiReport, '长度:', finalAiReport ? finalAiReport.length : 0);

        // 构建报告对象 - 改进的summary统计逻辑
        const summary = {
            riskLevel: analysisData.riskLevel || 'unknown',
            analyzedAt: new Date().toISOString(),
            aiAnalyzed: !!finalAiReport
        };

        // 尝试从多个数据源提取统计信息
        // 1. 从analysisData顶层直接获取
        if (analysisData.urls) {
            summary.totalUrls = Array.isArray(analysisData.urls) ? analysisData.urls.length : 0;
        }
        if (analysisData.fileOperations) {
            summary.totalFileOps = Array.isArray(analysisData.fileOperations) ? analysisData.fileOperations.length : 0;
        }
        if (analysisData.networkActivity) {
            summary.totalNetworkAct = Array.isArray(analysisData.networkActivity) ? analysisData.networkActivity.length : 0;
        }
        if (analysisData.suspiciousPatterns) {
            summary.suspiciousPatterns = Array.isArray(analysisData.suspiciousPatterns) ? analysisData.suspiciousPatterns.length : 0;
        }

        // 2. 从emailInfo/structureInfo中提取URL
        if (!summary.totalUrls && (analysisData.emailInfo || analysisData.structureInfo)) {
            const emailInfo = analysisData.emailInfo || analysisData.structureInfo || {};
            const urls = emailInfo.urlsFound || [];
            summary.totalUrls = Array.isArray(urls) ? urls.length : 0;
        }

        // 3. 从extractedAttachments统计文件操作
        if (!summary.totalFileOps && analysisData.extractedAttachments) {
            summary.totalFileOps = Array.isArray(analysisData.extractedAttachments) ? analysisData.extractedAttachments.length : 0;
        }
        if (!summary.totalFileOps && analysisData.emailInfo && analysisData.emailInfo.attachments) {
            summary.totalFileOps = Array.isArray(analysisData.emailInfo.attachments) ? analysisData.emailInfo.attachments.length : 0;
        }

        // 4. 确保所有字段都有默认值
        summary.totalUrls = summary.totalUrls || 0;
        summary.totalFileOps = summary.totalFileOps || 0;
        summary.totalNetworkAct = summary.totalNetworkAct || 0;
        summary.suspiciousPatterns = summary.suspiciousPatterns || 0;

        const report = {
            id: reportId,
            displayId: displayFilename, // 用于显示的原始文件名（已解码的中文）
            timestamp: new Date().toISOString(),
            user_id: req.user.id,
            fileInfo: fileInfo,
            analysis: analysisData,
            aiGeneratedReport: finalAiReport,  // 统一使用aiGeneratedReport字段名
            summary: summary,
            recommendations: generateRecommendations(analysisData)
        };

        // 保存报告
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

        // 保存报告元数据到数据库
        userService.saveReportMeta(req.user.id, {
            reportId: reportId,
            displayId: displayFilename,
            fileName: fileInfo.originalName || fileInfo.filename || '',
            riskLevel: analysisData.riskLevel || 'unknown',
            filePath: reportPath
        });

        res.json({
            success: true,
            reportId: reportId,
            reportPath: reportPath,
            report: report
        });

    } catch (error) {
        console.error('报告生成失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 获取所有报告列表
 * GET /api/report/list
 */
router.get('/list', (req, res) => {
    try {
        const userReportDir = getUserReportDir(req.user.username);
        const reports = [];

        if (fs.existsSync(userReportDir)) {
            const files = fs.readdirSync(userReportDir);

            files.forEach(file => {
                if (file.endsWith('.json')) {
                    const filePath = path.join(userReportDir, file);
                    try {
                        const reportContent = fs.readFileSync(filePath, 'utf-8');
                        const report = JSON.parse(reportContent);
                        reports.push({
                            id: report.id,
                            displayId: report.displayId,
                            timestamp: report.timestamp,
                            fileInfo: report.fileInfo,
                            summary: report.summary
                        });
                    } catch (err) {
                        console.error(`读取报告失败: ${file}`, err);
                    }
                }
            });
        }

        // 按时间戳排序（最新的在前）
        reports.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json({ success: true, reports });
    } catch (error) {
        console.error('获取报告列表失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 获取单个报告详情
 * GET /api/report/:id
 */
router.get('/:id', (req, res) => {
    try {
        const reportId = req.params.id;
        // 使用 findReportPath 优先查找用户目录，回退根目录（兼容旧数据）
        const reportPath = findReportPath(reportId, req.user.id);

        console.log(`[获取报告详情] reportId: ${reportId}, 路径: ${reportPath}`);

        if (!fs.existsSync(reportPath)) {
            console.log(`[获取报告详情] 报告不存在: ${reportPath}`);
            return res.status(404).json({ error: '报告不存在' });
        }

        const reportContent = fs.readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(reportContent);

        res.json(report);
    } catch (error) {
        console.error('获取报告详情失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 删除报告
 * DELETE /api/report/:id
 */
router.delete('/:id', (req, res) => {
    try {
        const reportId = req.params.id;
        const userReportDir = getUserReportDir(req.user.username);
        const reportPath = path.join(userReportDir, `${reportId}.json`);

        if (!fs.existsSync(reportPath)) {
            return res.status(404).json({ error: '报告不存在' });
        }

        fs.unlinkSync(reportPath);

        // 同时删除数据库中的元数据
        userService.deleteReportMeta(req.user.id, reportId);

        res.json({ success: true, message: '报告已删除' });
    } catch (error) {
        console.error('删除报告失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 生成HTML报告
 * GET /api/report/:id/html
 */
router.get('/:id/html', (req, res) => {
    try {
        const reportId = req.params.id;
        const userReportDir = getUserReportDir(req.user.username);
        const reportPath = path.join(userReportDir, `${reportId}.json`);

        if (!fs.existsSync(reportPath)) {
            return res.status(404).json({ error: '报告不存在' });
        }

        const reportContent = fs.readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(reportContent);

        const htmlContent = generateHTMLReport(report);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(htmlContent);
    } catch (error) {
        console.error('生成HTML报告失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 下载报告
 * GET /api/report/:id/download
 */
router.get('/:id/download', (req, res) => {
    try {
        const reportId = req.params.id;
        const reportPath = findReportPath(reportId, req.user.id);

        if (!fs.existsSync(reportPath)) {
            return res.status(404).json({ error: '报告不存在' });
        }

        const reportContent = fs.readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(reportContent);

        const htmlContent = generateHTMLReport(report);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');

        // 使用displayId（原始文件名）生成下载文件名，如果没有则从fileInfo获取
        let displayName = report.displayId || report.fileInfo?.fileName || reportId;

        // 尝试解码URL编码的文件名（如果存在）
        try {
            // 检查是否包含URL编码格式（%XX）
            if (/%[0-9A-F]{2}/i.test(displayName)) {
                displayName = decodeURIComponent(displayName);
            }
            // 检查是否包含下划线格式的URL编码（E5_85_B8）
            else if (/E[0-9A-F]{2}_/i.test(displayName)) {
                displayName = decodeURIComponent(displayName.replace(/_/g, '%'));
            }
        } catch (e) {
            console.log('[下载报告] 文件名解码失败:', e.message);
        }

        // 移除原始文件扩展名（如.eml），然后添加.html
        const baseName = displayName.replace(/\.[^.]+$/, '');

        // 对中文文件名进行URL编码（使用encodeURIComponent）
        const encodedFilename = encodeURIComponent(baseName + '.html');
        // ASCII fallback文件名（仅包含英文、数字和下划线）
        const asciiFilename = baseName.replace(/[^\x00-\x7F]/g, '_') + '.html';

        // filename* 放在 filename 之前，优先使用RFC 5987编码
        // 注意：filename*的值不能加引号
        res.setHeader('Content-Disposition',
            "attachment; filename*=UTF-8''" + encodedFilename + '; filename="' + asciiFilename + '"');

        console.log('[HTML下载] 显示名:', displayName);
        console.log('[HTML下载] 基础名:', baseName);
        console.log('[HTML下载] 编码后:', encodedFilename);
        console.log('[HTML下载] ASCII:', asciiFilename);

        // 发送HTML内容
        res.send(htmlContent);
    } catch (error) {
        console.error('下载报告失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 导出报告 (HTML格式)
 * GET /api/report/:id/export
 */
router.get('/:id/export', (req, res) => {
    try {
        const reportId = req.params.id;
        const reportPath = findReportPath(reportId, req.user.id);

        console.log(`[导出报告] 查找文件: ${reportPath}`);

        if (!fs.existsSync(reportPath)) {
            console.log(`[导出报告] 文件不存在: ${reportPath}`);
            return res.status(404).json({ error: '报告不存在' });
        }

        const reportContent = fs.readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(reportContent);

        console.log(`[导出报告] 报告ID: ${report.id}`);

        const htmlContent = generateHTMLReport(report);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');

        // 使用displayId（原始文件名）生成下载文件名，如果没有则从fileInfo获取
        let displayName = report.displayId || report.fileInfo?.fileName || reportId;

        // 尝试解码URL编码的文件名（如果存在）
        try {
            // 检查是否包含URL编码格式（%XX）
            if (/%[0-9A-F]{2}/i.test(displayName)) {
                displayName = decodeURIComponent(displayName);
            }
            // 检查是否包含下划线格式的URL编码（E5_85_B8）
            else if (/E[0-9A-F]{2}_/i.test(displayName)) {
                displayName = decodeURIComponent(displayName.replace(/_/g, '%'));
            }
        } catch (e) {
            console.log('[导出报告] 文件名解码失败:', e.message);
        }

        // 移除原始文件扩展名（如.eml），然后添加.html
        const baseName = displayName.replace(/\.[^.]+$/, '');

        // 对中文文件名进行URL编码（使用encodeURIComponent）
        const encodedFilename = encodeURIComponent(baseName + '.html');
        // ASCII fallback文件名（仅包含英文、数字和下划线）
        const asciiFilename = baseName.replace(/[^\x00-\x7F]/g, '_') + '.html';

        // filename* 放在 filename 之前，优先使用RFC 5987编码
        res.setHeader('Content-Disposition',
            "attachment; filename*=UTF-8''" + encodedFilename + '; filename="' + asciiFilename + '"');

        console.log('[导出报告] 显示名:', displayName);
        console.log('[导出报告] 基础名:', baseName);
        console.log('[导出报告] 编码后:', encodedFilename);
        console.log('[导出报告] ASCII:', asciiFilename);
        res.send(htmlContent);
    } catch (error) {
        console.error('导出报告失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 下载PDF报告
 * GET /api/report/:id/download/pdf
 */
router.get('/:id/download/pdf', async (req, res) => {
    try {
        const reportId = req.params.id;
        const reportPath = findReportPath(reportId, req.user.id);

        console.log(`[PDF下载] 查找文件: ${reportPath}`);

        if (!fs.existsSync(reportPath)) {
            console.log(`[PDF下载] 文件不存在: ${reportPath}`);
            return res.status(404).json({ error: '报告不存在' });
        }

        const reportContent = fs.readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(reportContent);

        console.log(`[PDF下载] 报告ID: ${report.id}`);

        // 生成HTML内容
        const htmlContent = generateHTMLReport(report);

        // 转换为PDF - 使用浏览器渲染服务，完美保留CSS样式
        console.log('[PDF下载] 使用浏览器PDF服务生成PDF...');
        const pdfBuffer = await pdfBrowserService.convertFullHtmlToPdf(htmlContent, {
            title: report.displayId || '安全分析报告'
        });
        console.log(`[PDF下载] PDF生成成功, 大小: ${pdfBuffer.length} bytes`);

        // 设置响应头
        res.setHeader('Content-Type', 'application/pdf');

        // 使用displayId（原始文件名）生成下载文件名，如果没有则从fileInfo获取
        let displayName = report.displayId || report.fileInfo?.fileName || reportId;

        // 尝试解码URL编码的文件名（如果存在）
        try {
            // 检查是否包含URL编码格式（%XX）
            if (/%[0-9A-F]{2}/i.test(displayName)) {
                displayName = decodeURIComponent(displayName);
            }
            // 检查是否包含下划线格式的URL编码（E5_85_B8）
            else if (/E[0-9A-F]{2}_/i.test(displayName)) {
                displayName = decodeURIComponent(displayName.replace(/_/g, '%'));
            }
        } catch (e) {
            console.log('[PDF下载] 文件名解码失败:', e.message);
        }

        // 移除原始文件扩展名（如.eml），然后添加.pdf
        const baseName = displayName.replace(/\.[^.]+$/, '');

        // 对中文文件名进行URL编码（使用encodeURIComponent）
        const encodedFilename = encodeURIComponent(baseName + '.pdf');
        // ASCII fallback文件名（仅包含英文、数字和下划线）
        const asciiFilename = baseName.replace(/[^\x00-\x7F]/g, '_') + '.pdf';

        // filename* 放在 filename 之前，优先使用RFC 5987编码
        // 注意：UTF-8后面是两个单引号（空语言标签），filename*的值不能加引号
        res.setHeader('Content-Disposition',
            "attachment; filename*=UTF-8''" + encodedFilename + '; filename="' + asciiFilename + '"');

        console.log('[PDF下载] 显示名:', displayName);
        console.log('[PDF下载] 基础名:', baseName);
        console.log('[PDF下载] 编码后:', encodedFilename);
        console.log('[PDF下载] ASCII:', asciiFilename);

        // 使用 res.end() 而不是 res.send() 来确保二进制数据不被修改
        res.end(pdfBuffer);
    } catch (error) {
        console.error('下载PDF报告失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 格式化文件大小
 */
function generateRecommendations(analysis) {
    const recommendations = [];
    const riskLevel = analysis.riskLevel || 'unknown';

    switch (riskLevel.toLowerCase()) {
        case 'critical':
            recommendations.push('🚨 极高风险！立即隔离并深度分析');
            recommendations.push('📊 联系安全团队进行全面审计');
            recommendations.push('🔒 隔离相关系统，防止横向移动');
            recommendations.push('📝 保留证据，配合安全调查');
            break;

        case 'high':
            recommendations.push('⚠️ 高风险！需要立即关注');
            recommendations.push('🔍 进行深度分析和行为监控');
            recommendations.push('🛡️ 检查相关系统安全配置');
            recommendations.push('📋 加强日志监控和异常检测');
            break;

        case 'medium':
            recommendations.push('⚡ 中等风险，需要进一步调查');
            recommendations.push('🔬 建议使用沙箱环境详细分析');
            recommendations.push('❓ 检查来源和可信度');
            recommendations.push('📊 监控相关进程和行为');
            break;

        case 'low':
            recommendations.push('✓ 风险较低，建议常规检查');
            recommendations.push('🔍 定期安全审计');
            recommendations.push('📋 监控 suspicious 行为');
            break;

        case 'safe':
        case 'minimal':
            recommendations.push('✓ 风险极低，文件相对安全');
            recommendations.push('🔍 建议常规安全检查');
            break;

        default:
            recommendations.push('❓ 无法确定风险级别，建议手动审查');
            recommendations.push('🔍 进行全面的安全检查');
    }

    // 基于分析结果添加更多建议
    if (analysis.urls && analysis.urls.length > 0) {
        recommendations.push('🌐 检测到网络活动，需审查URL');
    }

    if (analysis.fileOperations && analysis.fileOperations.length > 0) {
        recommendations.push('📁 检测到文件操作，需监控文件行为');
    }

    if (analysis.maliciousBehavior && analysis.maliciousBehavior.length > 0) {
        recommendations.push('🦠 检测到恶意行为，建议立即处理');
    }

    return recommendations;
}

/**
 * 生成HTML格式报告
 * 【简化版本】只生成基本HTML骨架，所有报告内容由AI生成
 */
function generateHTMLReport(report) {
    console.log('[generateHTMLReport] 开始生成HTML报告');

    // 如果AI生成的报告存在
    if (report.aiGeneratedReport && typeof report.aiGeneratedReport === 'string') {
        const content = report.aiGeneratedReport.trim();

        // 检查是否已经是完整的美化HTML文档（包含关键CSS类）
        const hasStyledHeader = content.includes('report-header') &&
            content.includes('report-wrapper') &&
            content.includes('risk-badge-main');
        const hasFullHtml = content.includes('<!DOCTYPE html>') || content.includes('<html');

        // 如果是完整HTML，直接返回（不强制处理，避免影响原有样式）
        if (hasStyledHeader && hasFullHtml) {
            console.log('[generateHTMLReport] AI报告已是完整美化HTML，直接返回');
            return content;
        }

        // 如果是完整HTML但没有美化样式，重新包装
        if (hasFullHtml && !hasStyledHeader) {
            console.log('[generateHTMLReport] AI报告是HTML但无美化样式，重新构建');
            return rebuildStyledReport(content, report);
        }

        // 否则包装AI内容
        console.log('[generateHTMLReport] AI报告不是完整HTML，进行包装');
        return wrapAIContent(content);
    }

    // 没有AI报告时的兜底内容
    console.log('[generateHTMLReport] 无AI报告内容，生成默认报告');
    return wrapAIContent('<p>暂无AI分析报告</p>');
}

/**
 * 从HTML报告内容中提取风险评级（兼容旧报告）
 * @param {string} htmlContent - 报告HTML内容
 * @returns {string|null} 风险等级或 null
 */
function extractRiskLevelFromHTML(htmlContent) {
    if (!htmlContent || typeof htmlContent !== 'string') {
        return null;
    }

    // 策略1：提取结构化HTML注释标记 <!-- RISK_ASSESSMENT: xxx -->
    const commentMatch = htmlContent.match(/<!--\s*RISK_ASSESSMENT\s*:\s*(\w+)\s*-->/i);
    if (commentMatch) {
        const level = commentMatch[1].toLowerCase();
        const validLevels = ['critical', 'high', 'medium', 'low', 'safe', 'minimal'];
        if (validLevels.includes(level)) {
            return level;
        }
    }

    // 策略2：从risk-badge-main徽章提取（已知格式的报告头部）
    const badgeMatch = htmlContent.match(/risk-badge-main[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
    if (badgeMatch) {
        const badgeText = badgeMatch[1].trim();
        const badgeToLevel = {
            '高危风险': 'high', '中危风险': 'medium', '低危风险': 'low',
            '极低风险': 'minimal', '安全': 'safe', '未知': null
        };
        if (badgeToLevel[badgeText] !== undefined && badgeToLevel[badgeText] !== null) {
            return badgeToLevel[badgeText];
        }
    }

    // 策略3：从HTML标签模式提取
    const tagPatterns = [
        { pattern: /class=["'][^"']*tag-high[^"']*["']/i, level: 'high' },
        { pattern: /class=["'][^"']*tag-medium[^"']*["']/i, level: 'medium' },
        { pattern: /class=["'][^"']*tag-low[^"']*["']/i, level: 'low' },
        { pattern: /class=["'][^"']*tag-info[^"']*["']/i, level: 'safe' },
    ];
    for (const { pattern, level } of tagPatterns) {
        if (pattern.test(htmlContent)) {
            return level;
        }
    }

    // 策略4：从中文风险关键词提取
    const textContent = htmlContent
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&\w+;/g, ' ')
        .replace(/\s+/g, ' ');

    const chineseRiskPatterns = [
        { pattern: /严重|Critical/i, level: 'critical' },
        { pattern: /高危|高风险|High/i, level: 'high' },
        { pattern: /中危|中风险|中等风险|Medium/i, level: 'medium' },
        { pattern: /低危|低风险|Low/i, level: 'low' },
        { pattern: /安全|无风险|Safe/i, level: 'safe' },
    ];

    for (const { pattern, level } of chineseRiskPatterns) {
        if (pattern.test(textContent)) {
            return level;
        }
    }

    return null;
}

/**
 * 重新构建带有美化样式的报告
 * 从已有HTML内容中提取body部分，添加美化头部
 */
function rebuildStyledReport(htmlContent, report) {
    console.log('[rebuildStyledReport] 重新构建美化报告');

    // 提取body内容
    let bodyContent = htmlContent;
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
        bodyContent = bodyMatch[1].trim();
    }

    // 移除已有的简单容器div
    bodyContent = bodyContent.replace(/<div class="container">([\s\S]*)<\/div>\s*$/, '$1');

    // 对提取的内容进行验证和清理，防止格式问题
    // 只移除会导致"图标变成整个板块"的特定样式（只匹配容器级别的样式）
    // 不再移除动态框的背景色等重要样式
    bodyContent = bodyContent.replace(/(<div[^>]*)(style\s*=\s*["'][^""]*(?:width\s*:\s*100%|height\s*:\s*\d+px|margin\s*:\s*auto)[^""]*["'])(>[\s\S]*?<\/div>)/gi, '$1$3');

    // 修复表格中可能的问题
    bodyContent = bodyContent.replace(/<table[^>]*>/gi, '<table style="width: 100%; border-collapse: collapse;">');

    // ===== 专门针对"分析结论"部分的处理 =====
    // 检测并包装"分析结论"相关内容，添加专门的class和样式
    // 匹配模式：包含"分析结论"标题的内容块
    const conclusionPattern = /(<h[1-6][^>]*>.*?分析结论.*?<\/h[1-6]>)([\s\S]*?)(?=<h[1-6]|$)/i;

    bodyContent = bodyContent.replace(conclusionPattern, (match, header, content) => {
        // 修复内容中的样式问题
        let fixedContent = content;

        // 1. 修复白色/透明文字 -> 改为深色文字
        fixedContent = fixedContent.replace(/(style\s*=\s*["'][^"']*)color\s*:\s*(white|#fff(?:fff)?|rgba?\s*\(\s*255\s*,\s*255\s*,\s*255[^)]*\))([^"']*["'])/gi, '$1color: #333333;$3');

        // 2. 修复居中对齐 -> 改为左对齐
        fixedContent = fixedContent.replace(/(style\s*=\s*["'][^"']*)text-align\s*:\s*center([^"']*["'])/gi, '$1text-align: left$2');
        fixedContent = fixedContent.replace(/(style\s*=\s*["'][^"']*)text-align\s*:\s*center\s*!important([^"']*["'])/gi, '$1text-align: left !important$2');

        // 3. 包装在大块div中的内容，尝试转为更紧凑的格式
        // 移除过大的宽度和浮动
        fixedContent = fixedContent.replace(/(style\s*=\s*["'][^"']*)width\s*:\s*100%([^"']*["'])/gi, '$1$2');
        fixedContent = fixedContent.replace(/(style\s*=\s*["'][^"']*)float\s*:\s*(left|right)([^"']*["'])/gi, '$1$3');

        // 4. 添加专门的分析结论容器class
        return `<div class="ai-conclusion-section">${header}${fixedContent}</div>`;
    });

    // 如果上面的模式没有匹配到，尝试更宽泛的匹配（针对没有标题的情况）
    // 检查是否已经包含 ai-conclusion-section，如果没有则尝试其他方式
    if (!bodyContent.includes('ai-conclusion-section')) {
        // 尝试查找可能包含"结论"、"分析结论"等关键词的内容块
        bodyContent = bodyContent.replace(/(<div[^>]*>[\s\S]*?(?:结论|分析结论)[\s\S]*?<\/div>)/gi, (match) => {
            // 检查是否已有特殊class
            if (!match.includes('ai-conclusion-section')) {
                // 修复样式问题
                let fixed = match;
                fixed = fixed.replace(/(style\s*=\s*["'][^"']*)color\s*:\s*(white|#fff(?:fff)?|rgba?\s*\(\s*255\s*,\s*255\s*,\s*255[^)]*\))([^"']*["'])/gi, '$1color: #333333;$3');
                fixed = fixed.replace(/(style\s*=\s*["'][^"']*)text-align\s*:\s*center([^"']*["'])/gi, '$1text-align: left$2');
                return fixed;
            }
            return match;
        });
    }

    // 从report中获取初始风险等级
    let riskLevel = report.summary?.riskLevel || 'unknown';

    // 尝试从AI报告HTML内容中提取更准确的风险评级（覆盖初始sandbox评级）
    if (htmlContent) {
        const aiRisk = extractRiskLevelFromHTML(htmlContent);
        if (aiRisk) {
            console.log(`[rebuildStyledReport] 从AI内容提取到风险评级: ${aiRisk}, 覆盖存储的评级: ${riskLevel}`);
            riskLevel = aiRisk;
        }
    }

    const filename = report.displayId || report.fileInfo?.originalName || '未知文件';
    const fileSize = formatFileSize(report.fileInfo?.size || 0);
    const analysisDate = new Date(report.timestamp).toLocaleString('zh-CN');

    // 风险等级配置 - 与sandbox.js保持一致
    const riskConfig = {
        'high': { color: '#ff4d4f', bg: '#fff1f0', icon: '🔴', label: '高危风险', gradient: 'linear-gradient(135deg, #ff4d4f 0%, #ff7875 100%)' },
        'medium': { color: '#faad14', bg: '#fffbe6', icon: '🟡', label: '中危风险', gradient: 'linear-gradient(135deg, #faad14 0%, #ffc53d 100%)' },
        'low': { color: '#52c41a', bg: '#f6ffed', icon: '🟢', label: '低危风险', gradient: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)' },
        'minimal': { color: '#52c41a', bg: '#f6ffed', icon: '✅', label: '极低风险', gradient: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)' },
        'safe': { color: '#52c41a', bg: '#f6ffed', icon: '✅', label: '安全', gradient: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)' },
        'unknown': { color: '#8c8c8c', bg: '#f5f5f5', icon: '⚪', label: '未知', gradient: 'linear-gradient(135deg, #8c8c8c 0%, #bfbfbf 100%)' }
    };
    const risk = riskConfig[riskLevel] || riskConfig['unknown'];

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🔒 安全检测报告</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap');
        
        * { box-sizing: border-box; }
        
        body {
            font-family: 'Noto Sans SC', 'Microsoft YaHei', Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        
        .report-wrapper {
            max-width: 1000px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            overflow: hidden;
        }
        
        .report-header {
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            color: white;
            padding: 40px;
            position: relative;
            overflow: hidden;
        }
        
        .report-header::before {
            content: '';
            position: absolute;
            top: -50%;
            right: -10%;
            width: 400px;
            height: 400px;
            background: rgba(255,255,255,0.1);
            border-radius: 50%;
        }
        
        .report-header::after {
            content: '';
            position: absolute;
            bottom: -30%;
            left: -5%;
            width: 300px;
            height: 300px;
            background: rgba(255,255,255,0.05);
            border-radius: 50%;
        }
        
        .report-header-content {
            position: relative;
            z-index: 1;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 20px;
        }
        
        .report-title-section h1 {
            font-size: 2.2rem;
            margin: 0 0 10px 0;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .report-subtitle {
            font-size: 1rem;
            opacity: 0.9;
            margin: 0;
        }
        
        .risk-badge-main {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 15px 25px;
            border-radius: 50px;
            font-size: 1.1rem;
            font-weight: 600;
            background: white;
            color: ${risk.color};
            box-shadow: 0 10px 25px rgba(0,0,0,0.2);
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.02); }
        }
        
        .report-meta-bar {
            display: flex;
            flex-wrap: wrap;
            gap: 30px;
            padding: 20px 40px;
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            border-bottom: 1px solid #e9ecef;
        }
        
        .meta-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.95rem;
            color: #495057;
            background: white;
            padding: 8px 16px;
            border-radius: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
        
        .meta-item .icon {
            font-size: 1.2rem;
        }
        
        .report-container {
            padding: 40px;
        }
        
        .report-footer {
            text-align: center;
            padding: 20px;
            background: #f8f9fa;
            border-top: 1px solid #e9ecef;
            color: #6c757d;
            font-size: 0.9rem;
        }
        
        /* 内容区域样式 */
        .content-section {
            margin-bottom: 35px;
        }
        
        .content-section h2 {
            color: #1e3c72;
            font-size: 1.5rem;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e9ecef;
        }
        
        .content-section h3 {
            color: #2a5298;
            font-size: 1.2rem;
            margin: 20px 0 15px 0;
        }
        
        .content-section p {
            line-height: 1.8;
            color: #495057;
            margin-bottom: 15px;
        }
        
        .content-section ul, .content-section ol {
            padding-left: 25px;
            margin-bottom: 15px;
        }
        
        .content-section li {
            margin-bottom: 10px;
            line-height: 1.6;
        }
        
        /* 威胁等级样式 */
        .threat-high { color: #ff4d4f; font-weight: 600; }
        .threat-medium { color: #faad14; font-weight: 600; }
        .threat-low { color: #52c41a; font-weight: 600; }
        
        /* 代码块样式 */
        pre {
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            padding: 15px;
            overflow-x: auto;
            font-size: 0.9rem;
        }
        
        code {
            font-family: 'Consolas', 'Monaco', monospace;
            background: #f1f3f4;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 0.9em;
        }
        
        /* 表格样式 */
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }
        
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
        }
        
        th {
            background: #f8f9fa;
            font-weight: 600;
            color: #1e3c72;
        }
        
        /* 建议卡片样式 */
        .recommendation-card {
            background: linear-gradient(135deg, #f6ffed 0%, #ffffff 100%);
            border-left: 4px solid #52c41a;
            padding: 20px;
            margin: 15px 0;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        
        .recommendation-card.warning {
            background: linear-gradient(135deg, #fffbe6 0%, #ffffff 100%);
            border-left-color: #faad14;
        }
        
        .recommendation-card.danger {
            background: linear-gradient(135deg, #fff1f0 0%, #ffffff 100%);
            border-left-color: #ff4d4f;
        }
        
        /* 修复报告内容区域的文本颜色和布局问题 - 只影响.ai-generated类或特定结构 */
        .report-content-area .ai-generated,
        .report-content-area .report-section {
            color: #333333 !important;
        }
        
        /* 针对表格和列表项的修复 */
        .report-content-area table td,
        .report-content-area table th,
        .report-content-area ul li,
        .report-content-area ol li {
            color: #333333 !important;
            text-align: left !important;
        }
        
        /* 仅针对包含特定样式属性(白色文字、居中对齐)的元素 */
        .report-content-area [style*="color: white"],
        .report-content-area [style*="color:#ffffff"],
        .report-content-area [style*="color: #ffffff"],
        .report-content-area [style*="color:white"],
        .report-content-area [style*="color: #fff"],
        .report-content-area [style*="color: white !important"],
        .report-content-area [style*="color:#ffffff !important"] {
            color: #333333 !important;
        }
        
        .report-content-area [style*="text-align: center"],
        .report-content-area [style*="text-align:center"] {
            text-align: left !important;
        }
        
        /* ===== 专门针对"分析结论"部分的样式 ===== */
        .ai-conclusion-section {
            background: #fafafa;
            border-left: 4px solid #1890ff;
            padding: 15px 20px;
            margin: 15px 0;
            border-radius: 4px;
        }
        
        /* 分析结论标题样式 */
        .ai-conclusion-section h1,
        .ai-conclusion-section h2,
        .ai-conclusion-section h3,
        .ai-conclusion-section h4,
        .ai-conclusion-section h5,
        .ai-conclusion-section h6 {
            color: #1e3c72 !important;
            margin-top: 0 !important;
            text-align: left !important;
        }
        
        /* 分析结论内容样式 - 强制覆盖内联样式 */
        .ai-conclusion-section * {
            color: #333333 !important;
            text-align: left !important;
            font-size: 14px !important;
            line-height: 1.6 !important;
        }
        
        /* 特别处理分析结论内部的div和span - 保留背景色用于PDF */
        .ai-conclusion-section div,
        .ai-conclusion-section span,
        .ai-conclusion-section p,
        .ai-conclusion-section li {
            color: #333333 !important;
            text-align: left !important;
            /* 不再强制移除背景色，保留动态框的原有背景 */
            float: none !important;
            width: auto !important;
            max-width: 100% !important;
        }
        
        /* 全局 print-color-adjust 确保PDF保持背景色 */
        * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
        }
        
        /* 修复分析结论中的表格 */
        .ai-conclusion-section table {
            width: 100% !important;
            border-collapse: collapse !important;
            background: white !important;
        }
        
        .ai-conclusion-section td,
        .ai-conclusion-section th {
            color: #333333 !important;
            text-align: left !important;
            padding: 8px !important;
            border: 1px solid #ddd !important;
        }
        
        /* 修复分析结论中的白色/透明文字 */
        .ai-conclusion-section [style*="color: white"],
        .ai-conclusion-section [style*="color:#ffffff"],
        .ai-conclusion-section [style*="color: #ffffff"],
        .ai-conclusion-section [style*="color:white"],
        .ai-conclusion-section [style*="color: rgb(255, 255, 255)"],
        .ai-conclusion-section [style*="color: rgb(255,255,255)"],
        .ai-conclusion-section [style*="color: white !important"],
        .ai-conclusion-section [style*="color:#ffffff !important"] {
            color: #333333 !important;
        }
        
        /* 修复分析结论中的居中对齐 */
        .ai-conclusion-section [style*="text-align: center"],
        .ai-conclusion-section [style*="text-align:center"],
        .ai-conclusion-section [style*="text-align: center !important"],
        .ai-conclusion-section [style*="text-align:center !important"] {
            text-align: left !important;
        }
        
        /* 修复分析结论中的大块div样式 */
        .ai-conclusion-section div[style*="width: 100%"],
        .ai-conclusion-section div[style*="width:100%"] {
            width: auto !important;
        }
        
        .ai-conclusion-section div[style*="float"] {
            float: none !important;
        }
        
        /* ===== PDF打印优化样式 ===== */
        @media print {
            /* 强制打印时保留背景色 */
            * {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
            
            /* 修复模块间多余空白 */
            .report-content-area {
                margin: 0 !important;
                padding: 0 !important;
            }
            
            .report-content-area > * {
                margin-bottom: 10px !important;
                page-break-inside: avoid;
            }
            
            /* 移除可能导致空白的元素 */
            .report-content-area br {
                display: none;
            }
            
            /* 确保表格正确打印 */
            table {
                page-break-inside: avoid;
            }
            
            /* 修复报告容器 */
            .report-container {
                padding: 10px !important;
            }
            
            /* 页眉页脚优化 */
            .report-header, .report-footer {
                page-break-after: avoid;
            }
        }
    </style>
</head>
<body>
    <div class="report-wrapper">
        <div class="report-header">
            <div class="report-header-content">
                <div class="report-title-section">
                    <h1>${filename} 安全分析报告</h1>
                    <p class="report-subtitle">AI 深度安全分析</p>
                </div>
                <div class="risk-badge-main">
                    <span>${risk.icon}</span>
                    <span>${risk.label}</span>
                </div>
            </div>
        </div>
        
        <div class="report-meta-bar">
            <div class="meta-item">
                <span class="icon">📄</span>
                <span>${filename}</span>
            </div>
            <div class="meta-item">
                <span class="icon">📊</span>
                <span>${fileSize}</span>
            </div>
            <div class="meta-item">
                <span class="icon">🕐</span>
                <span>${analysisDate}</span>
            </div>
        </div>
        
        <div class="report-container report-content-area">
            ${bodyContent}
        </div>
        
        <div class="report-footer">
            🔒 本报告由 AI 安全分析系统生成 | 仅供参考，请结合实际情况进行判断
        </div>
    </div>
</body>
</html>`;
}

/**
 * 验证并修复AI生成的内容，防止格式问题
 * 检测并修复可能导致"图标变成整个板块"等格式问题的内容
 */
function sanitizeAIContent(content) {
    let sanitized = content;

    // 简化处理：只做基本的Markdown到HTML转换

    // 1. 检查内容是否过短（可能是无效的AI响应）
    if (!sanitized || sanitized.length < 10) {
        return '<tr><td>暂无有效分析内容</td></tr>';
    }

    // 2. 移除可能的 Markdown 标题符号
    sanitized = sanitized.replace(/^#{1,6}\s+/gm, '');

    // 3. 移除可能的列表符号（如 "- " 或 "* "）
    sanitized = sanitized.replace(/^[\-\*]\s+/gm, '');

    // 4. 移除可能的数字列表（如 "1. "）
    sanitized = sanitized.replace(/^\d+\.\s+/gm, '');

    // 5. 清理空行
    sanitized = sanitized.trim();

    // 6. 处理换行 - 将连续换行转为表格行
    const lines = sanitized.split(/\n+/).filter(line => line.trim().length > 0);

    if (lines.length > 0) {
        // 将每行内容放入表格单元格中
        const rows = lines.map(line => {
            // 移除行首的行号或标签（如 "1."、"综合风险等级："等）
            let cleanLine = line.replace(/^(\d+[\.\)]\s*|[\u4e00-\u9fa5]+[：:]\s*)/, '');
            return `<tr><td>${cleanLine}</td></tr>`;
        });
        return rows.join('\n');
    }

    // 如果无法解析，直接返回原始内容作为单行
    return `<tr><td>${sanitized}</td></tr>`;
}

// 辅助函数：获取元素的默认样式
function getDefaultStyle(tag) {
    const baseStyle = 'color: #333333; font-size: 13px; text-align: left;';

    switch (tag.toLowerCase()) {
        case 'div':
            return baseStyle + ' max-width: 100%; word-wrap: break-word;';
        case 'p':
            return baseStyle + ' line-height: 1.6; margin: 8px 0;';
        case 'span':
            return baseStyle;
        case 'td':
        case 'th':
            return baseStyle + ' padding: 8px; border: 1px solid #ddd;';
        case 'li':
            return baseStyle + ' line-height: 1.6;';
        case 'label':
            return baseStyle + ' display: inline-block;';
        case 'h1':
            return 'color: #333333; font-size: 24px; text-align: left; font-weight: bold;';
        case 'h2':
            return 'color: #333333; font-size: 20px; text-align: left; font-weight: bold;';
        case 'h3':
            return 'color: #333333; font-size: 16px; text-align: left; font-weight: bold;';
        case 'h4':
            return 'color: #333333; font-size: 15px; text-align: left; font-weight: bold;';
        case 'h5':
            return 'color: #333333; font-size: 14px; text-align: left; font-weight: bold;';
        case 'h6':
            return 'color: #333333; font-size: 13px; text-align: left; font-weight: bold;';
        default:
            return baseStyle;
    }
}

/**
 * 将AI内容包装成完整HTML文档
 */
function wrapAIContent(aiContent) {
    // 验证和修复内容
    const sanitizedContent = sanitizeAIContent(aiContent);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>安全检测报告</title>
    <style>
        body {
            font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
            font-size: 14px;
            line-height: 1.6;
            color: #333;
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            background-color: #fff;
        }
        
        /* 表格样式 - 内容统一存放在表格中 */
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 10px 0;
        }
        
        td {
            padding: 8px 12px;
            border: 1px solid #ddd;
            vertical-align: top;
            color: #333;
            font-size: 14px;
            line-height: 1.6;
        }
        
        tr:hover {
            background-color: #f9f9f9;
        }
    </style>
</head>
<body>
    <table>
        ${sanitizedContent}
    </table>
</body>
</html>`;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
