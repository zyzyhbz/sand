const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const decompiler = require('../services/decompiler');
const Quickmu = require('../services/quickmu');
const attachmentExtractor = require('../services/attachmentExtractor');
const aiReportService = require('../services/aiReportService');
const userService = require('../services/userService');

// 初始化服务实例(Decompiler已经是实例化了)
const quickmuService = new Quickmu();

// 生成报告的日志时间戳
const generateTimestamp = () => {
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

/**
 * 获取用户专属报告目录，按需创建
 * @param {number} userId - 用户ID
 * @returns {string} 用户报告目录路径
 */
function getUserReportDir(username) {
    const reportsDir = path.join(__dirname, '..', 'reports');
    const userDir = path.join(reportsDir, `user_${username}`);
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
function findReportPath(reportId, username) {
    const userReportPath = path.join(getUserReportDir(username), `${reportId}.json`);
    if (fs.existsSync(userReportPath)) {
        return userReportPath;
    }
    const reportsDir = path.join(__dirname, '..', 'reports');
    return path.join(reportsDir, `${reportId}.json`);
}

// 文件分析路由：处理各种文件类型的分析并生成报告
router.post('/analyze', async (req, res) => {
    const { filePath, fileType, generateReport = true } = req.body;  // 默认自动生成报告

    if (!filePath) {
        return res.status(400).json({ error: '文件路径不能为空' });
    }

    try {
        const ext = path.extname(filePath).toLowerCase();
        console.log(`[文件分析路由] 开始分析文件: ${filePath}`);
        console.log(`[文件分析路由] 提取到的扩展名 ext="${ext}"`);

        let fileContent = '';
        let fileStats = null;
        let extractedAttachments = [];  // 存储提取的附件信息
        let emailStructureInfo = null;

        // 读取文件内容和统计信息
        try {
            fileStats = fs.statSync(filePath);
            const maxContentLength = 10000; // 读取最大10KB内容

            // EML文件：处理附件和内容（不使用EmailAnalyzer）
            if (ext === '.eml') {
                fileContent = fs.readFileSync(filePath, 'utf-8');

                // 提取EML附件
                try {
                    console.log(`[文件分析路由] 开始提取EML附件...`);
                    extractedAttachments = await attachmentExtractor.extractAttachments(filePath);
                    console.log(`[文件分析路由] 提取到 ${extractedAttachments.length} 个附件`);

                    // 构建邮件结构信息（将交给AI分析）
                    emailStructureInfo = {
                        attachments: extractedAttachments.map(att => ({
                            filename: att.filename || '未知',
                            contentType: att.contentType || 'unknown',
                            size: att.size || 0,
                            filePath: att.filePath || null,
                            extractedText: att.extractedText || null
                        })),
                        urlsFound: [],
                        from: '未知发件人',
                        to: '未知收件人',
                        subject: '未知主题',
                        date: new Date().toISOString()
                    };

                    // 为每个附件添加提取的文本内容到fileContent（确保PPTX内容被提取）
                    for (const attachment of extractedAttachments) {
                        if (attachment.extractedText) {
                            console.log(`[文件分析路由] 附件 ${attachment.filename} 提取到文本内容，长度: ${attachment.extractedText.length}`);
                            fileContent += `\n\n=== 附件内容提取: ${attachment.filename} (${attachment.contentType}) ===\n`;
                            fileContent += attachment.extractedText.substring(0, 10000);  // 限制每个附件的前10000字符
                        } else if (attachment.filePath && (attachment.contentType || '').includes('pptx')) {
                            // PPTX附件如果没有提取到文本，尝试重试
                            console.log(`[文件分析路由] PPTX附件 ${attachment.filename} 没有提取到文本内容，重试提取...`);
                            try {
                                const pptxContent = await attachmentExtractor.extractPPTXContent(attachment.filePath);
                                // extractPPTXContent 返回字符串，不是对象
                                if (pptxContent && pptxContent.length > 0) {
                                    console.log(`[文件分析路由] PPTX附件 ${attachment.filename} 重试提取成功，长度: ${pptxContent.length}`);
                                    attachment.extractedText = pptxContent;
                                    fileContent += `\n\n=== PPTX附件内容: ${attachment.filename} ===\n`;
                                    fileContent += attachment.extractedText.substring(0, 10000);
                                }
                            } catch (pptxError) {
                                console.warn(`[文件分析路由] PPTX附件重试提取失败 ${attachment.filename}:`, pptxError.message);
                            }
                        }
                    }

                } catch (extractError) {
                    console.warn(`[文件分析路由] EML附件提取失败:`, extractError.message);
                    emailStructureInfo = {
                        attachments: [],
                        urlsFound: [],
                        from: '未知发件人',
                        to: '未知收件人',
                        subject: '未知主题',
                        date: new Date().toISOString()
                    };
                }
            }
            // 可执行文件：读取二进制数据
            else if (decompiler.isExecutable(filePath)) {
                const buffer = fs.readFileSync(filePath);
                fileContent = buffer.toString('binary').substring(0, maxContentLength);
                console.log(`[文件分析路由] 可执行文件,已读取二进制内容,长度: ${fileContent.length}`);
            }
            // 文本文件：读取完整内容
            else {
                fileContent = fs.readFileSync(filePath, 'utf-8').substring(0, maxContentLength);
            }
        } catch (error) {
            return res.status(500).json({
                error: `无法读取文件: ${error.message}`,
                message: '文件读取失败'
            });
        }

        let result;
        let riskLevel = 'unknown';

        // EML文件：构建分析结果供AI使用
        if (ext === '.eml') {
            console.log(`[文件分析路由] EML文件处理完成,内容长度: ${fileContent.length}`);

            result = {
                success: true,
                filePath: filePath,
                fileType: 'email',
                analysis: {
                    emailInfo: emailStructureInfo || {},
                    contentPreview: fileContent.substring(0, 1000),
                    fullContent: fileContent.substring(0, 15000),  // 增加截断限制以确保附件内容被包含
                    structureInfo: emailStructureInfo,
                    extractedAttachments: extractedAttachments || []  // 添加提取的附件信息
                },
                toolUsed: 'AI分析 + 附件提取',
                timestamp: new Date().toISOString()
            };
            // EML默认medium风险，AI将进行详细分析
            riskLevel = 'medium';
        }
        // 二进制可执行文件：调用Quickmu获取完整的静态分析结果,用于报告生成
        else if (decompiler.isExecutable(filePath)) {
            console.log(`[文件分析路由] 可执行文件，已调用Quickmu进行风险评估...`);

            let quickmuAnalysis = null;

            try {
                quickmuAnalysis = await quickmuService.getDetailedAnalysis(filePath);
                if (quickmuAnalysis && quickmuAnalysis.success) {
                    console.log(`[文件分析路由] Quickmu分析成功, 威胁分数: ${quickmuAnalysis.details.threatDetection?.threatScore || 0}`);

                    // 从Quickmu的结果中提取riskLevel
                    if (quickmuAnalysis.details.riskAssessment && quickmuAnalysis.details.riskAssessment.riskLevel) {
                        riskLevel = quickmuAnalysis.details.riskAssessment.riskLevel;
                    } else {
                        // 如果Quickmu没有返回riskLevel,基于威胁数量计算
                        const threatCount = quickmuAnalysis.details.threatDetection?.threats?.length || 0;
                        const highSeverityThreats = quickmuAnalysis.details.threatDetection?.threats?.filter(
                            t => t.severity === 'high'
                        ).length || 0;

                        if (highSeverityThreats > 0) {
                            riskLevel = 'high';
                        } else if (threatCount > 2) {
                            riskLevel = 'high';
                        } else if (threatCount > 0) {
                            riskLevel = 'medium';
                        } else {
                            riskLevel = 'low';
                        }
                    }
                } else {
                    console.warn(`[文件分析路由] Quickmu分析失败: ${quickmuAnalysis?.error || '未知错误'}`);
                }
            } catch (error) {
                console.warn(`[文件分析路由] Quickmu分析异常: ${error.message}`);
            }

            result = {
                success: true,
                filePath: filePath,
                fileType: 'executable',
                analysis: {
                    fileExtension: ext,
                    fileSize: fileStats ? fileStats.size : null,
                    decompiledContent: fileContent,
                    contentPreview: fileContent.substring(0, 500),
                    riskLevel: riskLevel,
                    quickmuAnalysis: quickmuAnalysis
                },
                toolUsed: 'Decompiler + Quickmu',
                timestamp: new Date().toISOString()
            };
        }
        // 其他文件类型：直接发送原始内容用于AI分析
        else {
            result = {
                success: true,
                filePath: filePath,
                fileType: 'other',
                analysis: {
                    fileExtension: ext,
                    fileSize: fileStats ? fileStats.size : null,
                    fileContent: fileContent,
                    contentPreview: fileContent.substring(0, 500)
                },
                toolUsed: '文件读取器',
                timestamp: new Date().toISOString()
            };
            riskLevel = 'low';
        }

        // 自动生成报告（如果需要）
        if (generateReport && result.success) {
            try {
                console.log(`[文件分析路由] 开始自动生成报告...`);

                const analysisData = {
                    analysis: result.analysis,
                    toolResults: [{
                        tool: result.toolUsed,
                        result: result.analysis
                    }],
                    fileInfo: {
                        fileName: path.basename(filePath),
                        filePath: filePath,
                        fileSize: fileStats ? fileStats.size : null,
                        fileType: fileType || ext,
                        uploadTime: new Date().toISOString()
                    }
                };

                const reportId = `report-${path.basename(filePath, ext)}-${Date.now()}`;
                const userReportDir = getUserReportDir(req.user.username);
                const fullPath = path.join(userReportDir, `${reportId}.json`);

                // 【新方案】分两步生成报告：1) AI生成分析内容 2) 后端构建前置格式并合并
                let aiReportContent = null;
                let reportHTML = null;

                try {
                    console.log(`[文件分析路由] 第一步：生成AI分析内容...`);
                    const toolUsed = result.toolUsed || 'AI深度分析';
                    const aiResult = await aiReportService.generateDetailedReport(
                        analysisData,
                        analysisData.fileInfo,
                        null,  // urlData
                        toolUsed
                    );

                    if (aiResult && aiResult.success && aiResult.html) {
                        aiReportContent = aiResult.html;
                        console.log(`[文件分析路由] AI分析内容生成成功，长度: ${aiReportContent.length}`);

                        // 第一步半：从AI原始内容中提取风险评级结论
                        const aiRiskLevel = extractRiskLevelFromAIContent(aiReportContent);
                        if (aiRiskLevel) {
                            console.log(`[文件分析路由] AI风险评级结论: ${aiRiskLevel}, 覆盖初始评级: ${riskLevel}`);
                            riskLevel = aiRiskLevel;
                        } else {
                            console.log(`[文件分析路由] 未能从AI内容中提取风险评级，保持初始评级: ${riskLevel}`);
                        }

                        // 第二步：清理AI生成的HTML头部（只保留内容部分）
                        console.log(`[文件分析路由] 第二步：清理AI内容的HTML骨架...`);
                        aiReportContent = cleanAIReportContent(aiReportContent);
                        console.log(`[文件分析路由] AI内容清理后长度: ${aiReportContent.length}`);

                        // 第三步：后端根据实际数据构建报告前置格式（使用AI结论的风险等级）
                        console.log(`[文件分析路由] 第三步：构建报告前置格式，风险等级: ${riskLevel}`);
                        const reportHeader = buildReportHeader(analysisData, riskLevel, toolUsed);

                        // 合并前置格式和AI分析内容，并添加HTML结束标签
                        const htmlFooter = `
        </div>
        <div class="report-footer">
            🔒 本报告由 AI 安全分析系统生成 | 仅供参考，请结合实际情况进行判断
        </div>
    </div>
</body>
</html>`;
                        reportHTML = reportHeader + aiReportContent + htmlFooter;
                        console.log(`[文件分析路由] 完整报告生成成功，总长度: ${reportHTML.length}`);
                    } else {
                        console.log(`[文件分析路由] AI分析内容生成失败或返回空结果`);
                        // AI失败时使用备用报告
                        reportHTML = generateFallbackReport(analysisData, riskLevel);
                    }
                } catch (aiError) {
                    console.error(`[文件分析路由] AI报告生成错误:`, aiError.message);
                    // AI失败时使用备用报告
                    reportHTML = generateFallbackReport(analysisData, riskLevel);
                }

                const reportData = {
                    id: reportId,
                    user_id: req.user.id,
                    timestamp: new Date().toISOString(),
                    fileInfo: analysisData.fileInfo,
                    summary: {
                        riskLevel: riskLevel || 'unknown',
                        analyzedAt: new Date().toISOString(),
                        aiAnalyzed: reportHTML ? true : false
                    },
                    analysis: analysisData.analysis,
                    toolResults: analysisData.toolResults,
                    aiGeneratedReport: reportHTML,  // 包含完整的报告HTML
                    recommendations: [
                        riskLevel === 'high' ? '立即隔离此文件，它包含恶意特征' :
                            riskLevel === 'medium' ? '警告：文件包含可疑特征' :
                                '文件未发现明显威胁'
                    ]
                };

                fs.writeFileSync(fullPath, JSON.stringify(reportData, null, 2));
                console.log(`[文件分析路由] 报告已生成: ${fullPath}, reportId="${reportId}"`);

                // 保存报告元数据到数据库
                try {
                    userService.saveReportMeta(req.user.id, {
                        reportId: reportId,
                        displayId: analysisData.fileInfo.fileName || '',
                        fileName: analysisData.fileInfo.fileName || '',
                        riskLevel: riskLevel || 'unknown',
                        filePath: fullPath
                    });
                    console.log(`[文件分析路由] 报告元数据已保存到数据库, reportId="${reportId}"`);
                } catch (dbError) {
                    console.error('[文件分析路由] 保存报告元数据失败:', dbError.message);
                }

                // 返回包含报告信息的对象
                res.json({
                    success: true,
                    reportId: reportId,
                    reportPath: fullPath,
                    report: reportData,
                    analysis: result.analysis,  // 添加analysis字段供前端使用
                    filePath: result.filePath,
                    timestamp: result.timestamp,
                    toolUsed: result.toolUsed,
                    riskLevel: riskLevel,
                    message: '分析完成并已生成报告'
                });

            } catch (reportError) {
                console.error('[文件分析路由] 生成报告错误:', reportError);
                // 报告生成失败时，仍返回分析结果但不包含报告信息
                res.json({
                    success: true,
                    analysis: result.analysis,
                    filePath: result.filePath,
                    timestamp: result.timestamp,
                    toolUsed: result.toolUsed,
                    riskLevel: riskLevel,
                    message: '分析完成，但报告生成失败',
                    error: reportError.message
                });
            }
        } else {
            res.json({
                success: true,
                analysis: result.analysis,
                filePath: result.filePath,
                timestamp: result.timestamp,
                toolUsed: result.toolUsed,
                riskLevel: riskLevel,
                message: '分析完成'
            });
        }

    } catch (error) {
        console.error('[文件分析路由] 处理错误:', error);
        return res.status(500).json({
            error: '分析失败',
            message: error.message
        });
    }
});

/**
 * 更新报告中的AI数据
 * POST /api/sandbox/update-report-ai
 * 用于前端AI分析完成后更新已有报告
 */
router.post('/update-report-ai', async (req, res) => {
    try {
        const { reportId, aiReport } = req.body;

        console.log(`[更新报告AI] ===== 开始更新报告AI数据 =====`);
        console.log(`[更新报告AI] reportId: ${reportId}`);
        console.log(`[更新报告AI] aiReport 类型: ${typeof aiReport}`);
        console.log(`[更新报告AI] aiReport 长度: ${aiReport ? aiReport.length : 0}`);
        console.log(`[更新报告AI] aiReport 前200字符: ${aiReport ? aiReport.substring(0, 200) : '无内容'}`);

        if (!reportId) {
            return res.status(400).json({ error: '缺少reportId参数' });
        }

        // 构建报告文件路径 - 优先用户子目录，回退根目录
        const reportPath = findReportPath(reportId, req.user.username);

        if (!fs.existsSync(reportPath)) {
            return res.status(404).json({ error: '报告文件不存在', reportPath });
        }

        // 读取现有报告
        const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

        console.log(`[更新报告AI] 读取到现有报告, 报告ID: ${reportData.id}`);
        console.log(`[更新报告AI] 原报告(aiGeneratedReport): ${reportData.aiGeneratedReport ? '存在' : '不存在'}`);

        // 检查现有报告是否已经是美化版本（防止降级）
        const existingReport = reportData.aiGeneratedReport;
        const isStyledReport = existingReport &&
            typeof existingReport === 'string' &&
            existingReport.includes('report-header') &&
            existingReport.includes('report-wrapper') &&
            existingReport.includes('risk-badge-main');

        const newIsStyled = aiReport &&
            typeof aiReport === 'string' &&
            aiReport.includes('report-header') &&
            aiReport.includes('report-wrapper');

        console.log(`[更新报告AI] 现有报告是美化版本: ${isStyledReport}`);
        console.log(`[更新报告AI] 新报告是美化版本: ${newIsStyled}`);
        console.log(`[更新报告AI] 现有报告长度: ${existingReport ? existingReport.length : 0}`);
        console.log(`[更新报告AI] 新报告长度: ${aiReport ? aiReport.length : 0}`);

        // 决定是否更新报告
        if (isStyledReport && !newIsStyled) {
            // 如果现有报告是美化版本，但新报告不是，则跳过更新（防止降级）
            console.log(`[更新报告AI] ⚠️ 跳过更新：现有报告是美化版本，新报告是简化版本`);
            console.log(`[更新报告AI] 保持现有美化报告不变`);

            // 只更新时间戳和AI分析状态，不改变报告内容
            reportData.summary.aiAnalyzed = true;
            reportData.updatedAt = new Date().toISOString();
            if (!reportData.originalTimestamp) {
                reportData.originalTimestamp = reportData.timestamp;
            }
            reportData.timestamp = new Date().toISOString();

            // 保存但不修改aiGeneratedReport
            fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));

            return res.json({
                success: true,
                message: '报告AI数据已是最新版本（跳过降级）',
                reportId: reportId,
                reportPath: reportPath,
                aiAnalyzed: true,
                skipped: true,
                reason: '防止简化版本覆盖美化版本',
                aiReportLength: existingReport ? existingReport.length : 0
            });
        }

        // 更新报告数据（新报告是美化版本，或者现有报告不是美化版本）
        reportData.aiGeneratedReport = aiReport;
        reportData.summary.aiAnalyzed = !!aiReport;
        reportData.updatedAt = new Date().toISOString();

        // 从AI内容中提取风险评级并更新
        let updatedRiskLevel = null;
        if (aiReport) {
            updatedRiskLevel = extractRiskLevelFromAIContent(aiReport);
            if (updatedRiskLevel) {
                const oldRiskLevel = reportData.summary?.riskLevel || 'unknown';
                console.log(`[更新报告AI] AI风险评级结论: ${updatedRiskLevel}, 原评级: ${oldRiskLevel}`);
                reportData.summary.riskLevel = updatedRiskLevel;
            } else {
                console.log(`[更新报告AI] 未能从AI内容中提取风险评级，保持原评级: ${reportData.summary?.riskLevel}`);
            }
        }

        // 更新时间戳,如果报告对象有timestamp字段
        if (!reportData.originalTimestamp) {
            reportData.originalTimestamp = reportData.timestamp;
        }
        reportData.timestamp = new Date().toISOString();

        // 保存更新后的报告
        fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));

        // 同步更新数据库中的风险等级
        if (updatedRiskLevel) {
            try {
                userService.updateReportRiskLevel(req.user.id, reportId, updatedRiskLevel);
                console.log(`[更新报告AI] 数据库风险等级已更新为: ${updatedRiskLevel}`);
            } catch (dbError) {
                console.error('[更新报告AI] 更新数据库风险等级失败:', dbError.message);
            }
        }

        console.log(`[更新报告AI] 报告已更新: ${reportPath}`);
        console.log(`[更新报告AI] AI报告已${reportData.aiGeneratedReport ? '成功' : '失败'}写入`);

        res.json({
            success: true,
            message: '报告AI数据已更新',
            reportId: reportId,
            reportPath: reportPath,
            aiAnalyzed: reportData.summary.aiAnalyzed,
            riskLevel: reportData.summary.riskLevel,
            aiReportLength: aiReport ? aiReport.length : 0
        });

    } catch (error) {
        console.error('[更新报告AI] 更新失败:', error);
        return res.status(500).json({
            error: '更新报告AI数据失败',
            message: error.message,
            stack: error.stack
        });
    }
});

/**
 * 从AI生成的报告HTML内容中提取风险评级结论
 * 按优先级尝试多种提取策略：
 * 1. 结构化HTML注释标记 <!-- RISK_ASSESSMENT: xxx -->
 * 2. HTML标签模式（tag-high/tag-medium/tag-low/tag-info）
 * 3. 中文风险关键词模式
 * @param {string} htmlContent - AI生成的HTML内容
 * @returns {string|null} 风险等级（high/medium/low/safe/critical/minimal）或 null
 */
function extractRiskLevelFromAIContent(htmlContent) {
    if (!htmlContent || typeof htmlContent !== 'string') {
        return null;
    }

    // 策略1：提取结构化HTML注释标记 <!-- RISK_ASSESSMENT: xxx -->
    const commentMatch = htmlContent.match(/<!--\s*RISK_ASSESSMENT\s*:\s*(\w+)\s*-->/i);
    if (commentMatch) {
        const level = commentMatch[1].toLowerCase();
        const validLevels = ['critical', 'high', 'medium', 'low', 'safe', 'minimal'];
        if (validLevels.includes(level)) {
            console.log(`[extractRiskLevel] 从HTML注释提取到风险评级: ${level}`);
            return level;
        }
    }

    // 策略2：从HTML标签模式提取（tag-high/tag-medium/tag-low/tag-info）
    const tagPatterns = [
        { pattern: /class=["'][^"']*tag-high[^"']*["']/i, level: 'high' },
        { pattern: /class=["'][^"']*tag-medium[^"']*["']/i, level: 'medium' },
        { pattern: /class=["'][^"']*tag-low[^"']*["']/i, level: 'low' },
        { pattern: /class=["'][^"']*tag-info[^"']*["']/i, level: 'safe' },
    ];
    for (const { pattern, level } of tagPatterns) {
        if (pattern.test(htmlContent)) {
            console.log(`[extractRiskLevel] 从tag标签提取到风险评级: ${level}`);
            return level;
        }
    }

    // 策略3：从中文风险关键词提取（在正文文本中搜索）
    // 需要在非CSS/非HTML标签区域搜索，提取纯文本内容
    const textContent = htmlContent
        .replace(/<style[\s\S]*?<\/style>/gi, '')    // 移除style标签
        .replace(/<[^>]+>/g, ' ')                      // 移除HTML标签
        .replace(/&\w+;/g, ' ')                         // 移除HTML实体
        .replace(/\s+/g, ' ');                          // 合并空白

    // 中文风险等级关键词（按优先级从高到低匹配）
    const chineseRiskPatterns = [
        { pattern: /严重|Critical/i, level: 'critical' },
        { pattern: /高危|高风险|High/i, level: 'high' },
        { pattern: /中危|中风险|中等风险|Medium/i, level: 'medium' },
        { pattern: /低危|低风险|Low/i, level: 'low' },
        { pattern: /安全|无风险|Safe/i, level: 'safe' },
    ];

    for (const { pattern, level } of chineseRiskPatterns) {
        if (pattern.test(textContent)) {
            console.log(`[extractRiskLevel] 从中文关键词提取到风险评级: ${level}`);
            return level;
        }
    }

    console.log(`[extractRiskLevel] 未能从AI内容中提取风险评级`);
    return null;
}

/**
 * 构建报告前置格式（文件信息、风险评级徽章等）
 * @param {object} analysisData - 分析数据
 * @param {string} riskLevel - 风险等级
 * @param {string} toolUsed - 使用的工具
 * @returns {string} HTML格式的报告头部
 */
function buildReportHeader(analysisData, riskLevel, toolUsed) {
    // 获取风险等级对应的样式和图标 - 更多彩色图标
    const riskConfig = {
        'high': { color: '#ff4d4f', bg: '#fff1f0', icon: '🔴', label: '高危风险', gradient: 'linear-gradient(135deg, #ff4d4f 0%, #ff7875 100%)' },
        'medium': { color: '#faad14', bg: '#fffbe6', icon: '🟡', label: '中危风险', gradient: 'linear-gradient(135deg, #faad14 0%, #ffc53d 100%)' },
        'low': { color: '#52c41a', bg: '#f6ffed', icon: '🟢', label: '低危风险', gradient: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)' },
        'minimal': { color: '#52c41a', bg: '#f6ffed', icon: '✅', label: '极低风险', gradient: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)' },
        'safe': { color: '#52c41a', bg: '#f6ffed', icon: '✅', label: '安全', gradient: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)' },
        'unknown': { color: '#8c8c8c', bg: '#f5f5f5', icon: '⚪', label: '未知', gradient: 'linear-gradient(135deg, #8c8c8c 0%, #bfbfbf 100%)' }
    };
    const risk = riskConfig[riskLevel] || riskConfig['unknown'];

    // 生成美观的报告头部 - 增强版
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${analysisData.fileInfo?.originalName || analysisData.filename || '未知文件'} 安全分析报告</title>
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
        
        /* 内容区域样式 - 增强版 */
        .content-section {
            margin-bottom: 35px;
            animation: fadeIn 0.5s ease-out;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .section-title {
            font-size: 1.5rem;
            color: #1e3c72;
            margin: 0 0 20px 0;
            display: flex;
            align-items: center;
            gap: 12px;
            padding-bottom: 12px;
            border-bottom: 3px solid ${risk.color};
            background: linear-gradient(90deg, ${risk.color}20 0%, transparent 100%);
            padding: 12px 16px;
            border-radius: 8px;
        }
        
        .section-icon {
            font-size: 1.8rem;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
        }
        
        /* 信息卡片 - 增强版 */
        .info-card {
            background: linear-gradient(135deg, ${risk.bg} 0%, white 100%);
            border-left: 5px solid ${risk.color};
            border-radius: 16px;
            padding: 25px;
            margin: 20px 0;
            box-shadow: 0 4px 15px rgba(0,0,0,0.08);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        
        .info-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.12);
        }
        
        .info-card-title {
            font-size: 1.2rem;
            font-weight: 600;
            color: ${risk.color};
            margin: 0 0 15px 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        /* 危险卡片 - 高危 */
        .danger-card {
            background: linear-gradient(135deg, #fee2e2 0%, #fef9c3 100%);
            border-left: 5px solid #dc2626;
            border-radius: 16px;
            padding: 25px;
            margin: 20px 0;
            box-shadow: 0 4px 15px rgba(220, 38, 38, 0.15);
        }
        
        .danger-card-title {
            font-size: 1.2rem;
            font-weight: 600;
            color: #dc2626;
            margin: 0 0 15px 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        /* 警告卡片 - 中危 */
        .warning-card {
            background: linear-gradient(135deg, #fef3c7 0%, #fef9c3 100%);
            border-left: 5px solid #f59e0b;
            border-radius: 16px;
            padding: 25px;
            margin: 20px 0;
            box-shadow: 0 4px 15px rgba(245, 158, 11, 0.15);
        }
        
        .warning-card-title {
            font-size: 1.2rem;
            font-weight: 600;
            color: #f59e0b;
            margin: 0 0 15px 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        /* 安全卡片 - 低危/安全 */
        .success-card {
            background: linear-gradient(135deg, #dcfce7 0%, #f0fdf4 100%);
            border-left: 5px solid #22c55e;
            border-radius: 16px;
            padding: 25px;
            margin: 20px 0;
            box-shadow: 0 4px 15px rgba(34, 197, 94, 0.15);
        }
        
        .success-card-title {
            font-size: 1.2rem;
            font-weight: 600;
            color: #22c55e;
            margin: 0 0 15px 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        /* 表格样式 - 增强版 */
        .data-table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            margin: 20px 0;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 15px rgba(0,0,0,0.08);
        }
        
        .data-table th {
            background: ${risk.gradient};
            color: white;
            padding: 16px;
            text-align: left;
            font-weight: 600;
            font-size: 0.95rem;
        }
        
        .data-table td {
            padding: 16px;
            border-bottom: 1px solid #e9ecef;
            background: white;
            transition: background 0.2s ease;
        }
        
        .data-table tr:last-child td {
            border-bottom: none;
        }
        
        .data-table tr:hover td {
            background: #f0f4f8;
        }
        
        /* 列表样式 - 增强版 */
        .styled-list {
            list-style: none;
            padding: 0;
            margin: 15px 0;
        }
        
        .styled-list li {
            padding: 14px 18px;
            margin: 10px 0;
            background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%);
            border-radius: 10px;
            display: flex;
            align-items: flex-start;
            gap: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.04);
            border-left: 3px solid ${risk.color};
            transition: all 0.2s ease;
        }
        
        .styled-list li:hover {
            transform: translateX(5px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
        }
        
        .styled-list li::before {
            content: '▸';
            color: ${risk.color};
            font-weight: bold;
            font-size: 1.2rem;
        }
        
        /* 高亮框 - 增强版 */
        .highlight-box {
            background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
            border-radius: 16px;
            padding: 24px;
            margin: 20px 0;
            border: 2px solid #90caf9;
            box-shadow: 0 4px 15px rgba(144,202,249,0.2);
        }
        
        .warning-box {
            background: linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%);
            border: 2px solid #ffb74d;
            box-shadow: 0 4px 15px rgba(255,183,77,0.2);
        }
        
        .danger-box {
            background: linear-gradient(135deg, #ffebee 0%, #ffcdd2 100%);
            border: 2px solid #ef5350;
            box-shadow: 0 4px 15px rgba(239,83,80,0.2);
        }
        
        .success-box {
            background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
            border: 2px solid #66bb6a;
            box-shadow: 0 4px 15px rgba(102,187,106,0.2);
        }
        
        /* 标签 - 增强版 */
        .tag {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 25px;
            font-size: 0.9rem;
            font-weight: 600;
            margin: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            transition: transform 0.2s ease;
        }
        
        .tag:hover {
            transform: translateY(-2px);
        }
        
        .tag-high { background: linear-gradient(135deg, #ffebee 0%, #ffcdd2 100%); color: #c62828; }
        .tag-medium { background: linear-gradient(135deg, #fff8e1 0%, #ffecb3 100%); color: #f57f17; }
        .tag-low { background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%); color: #2e7d32; }
        .tag-info { background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%); color: #1565c0; }
        
        /* 进度条 - 增强版 */
        .progress-bar {
            height: 12px;
            background: #e9ecef;
            border-radius: 6px;
            overflow: hidden;
            margin: 15px 0;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .progress-fill {
            height: 100%;
            background: ${risk.gradient};
            border-radius: 6px;
            transition: width 0.5s ease;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        }
        
        /* 代码块 - 增强版 */
        .code-block {
            background: linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%);
            color: #d4d4d4;
            padding: 24px;
            border-radius: 16px;
            overflow-x: auto;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 0.9rem;
            line-height: 1.6;
            box-shadow: 0 8px 25px rgba(0,0,0,0.15);
            border: 1px solid #3d3d3d;
        }
        
        /* 分隔线 - 增强版 */
        .divider {
            height: 2px;
            background: linear-gradient(90deg, transparent 0%, ${risk.color} 50%, transparent 100%);
            margin: 35px 0;
            opacity: 0.5;
        }
        
        /* 网格布局 - 增强版 */
        .grid-2 {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 24px;
            margin: 24px 0;
        }
        
        .grid-item {
            background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%);
            padding: 24px;
            border-radius: 16px;
            border: 2px solid #e9ecef;
            box-shadow: 0 4px 12px rgba(0,0,0,0.05);
            transition: all 0.3s ease;
        }
        
        .grid-item:hover {
            border-color: ${risk.color};
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.1);
        }
        
        /* 统计卡片 */
        .stat-card {
            background: linear-gradient(135deg, ${risk.gradient});
            color: white;
            padding: 24px;
            border-radius: 16px;
            text-align: center;
            box-shadow: 0 8px 25px rgba(0,0,0,0.15);
        }
        
        .stat-number {
            font-size: 2.5rem;
            font-weight: 700;
            margin: 10px 0;
        }
        
        .stat-label {
            font-size: 0.95rem;
            opacity: 0.9;
        }
        
        /* 页脚 - 增强版 */
        .report-footer {
            text-align: center;
            padding: 30px;
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            color: #6c757d;
            font-size: 0.9rem;
            border-top: 2px solid #e9ecef;
        }
        
        /* 打印样式 */
        @media print {
            body { background: white; }
            .report-wrapper { box-shadow: none; }
            .info-card, .grid-item { break-inside: avoid; }
        }
    </style>
</head>
<body>
    <div class="report-wrapper">
        <div class="report-header">
            <div class="report-header-content">
                <div class="report-title-section">
                    <h1>🔒 安全检测报告</h1>
                    <p class="report-subtitle">🤖 AI 深度分析 · 🛡️ 专业威胁评估</p>
                </div>
                <div class="risk-badge-main">
                    <span style="font-size: 1.8rem;">${risk.icon}</span>
                    <span>${risk.label}</span>
                </div>
            </div>
        </div>
        
        <div class="report-meta-bar">
            <div class="meta-item">
                <span class="icon">📁</span>
                <span>${analysisData.fileInfo?.fileName || '未知文件'}</span>
            </div>
            <div class="meta-item">
                <span class="icon">📅</span>
                <span>${new Date().toLocaleDateString('zh-CN')}</span>
            </div>
            <div class="meta-item">
                <span class="icon">🛠️</span>
                <span>${toolUsed || 'AI分析'}</span>
            </div>
            <div class="meta-item">
                <span class="icon">⏱️</span>
                <span>${new Date().toLocaleTimeString('zh-CN')}</span>
            </div>
        </div>
        
        <div class="report-container">
`;
}

/**
 * 格式化文件大小
 * @param {Number} bytes - 字节数
 * @returns {String} 格式化后的大小
 */
function formatFileSize(bytes) {
    if (bytes === 0 || !bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 生成备用报告（当AI服务失败时使用）
 * @param {Object} analysisData - 分析数据
 * @param {String} riskLevel - 风险等级
 * @returns {String} HTML格式的备用报告
 */
function generateFallbackReport(analysisData, riskLevel) {
    const header = buildReportHeader(analysisData, riskLevel, '基础分析');
    const analysis = analysisData.analysis || {};

    // 构建基础分析内容
    let content = `
        <div style="background: #fff2f0; border: 1px solid #ffccc7; border-radius: 4px; padding: 20px; margin: 20px 0;">
            <h3 style="color: #ff4d4f; margin-top: 0;">AI分析服务暂时不可用</h3>
            <p>以下是基于基础规则的分析结果：</p>
        </div>
        
        <div class="section-title">检测到的行为</div>
`;

    // 添加网络活动
    if (analysis.networkActivity && analysis.networkActivity.length > 0) {
        content += `
        <div style="margin: 15px 0;">
            <h4>网络活动 (${analysis.networkActivity.length}项)</h4>
            <ul>
                ${analysis.networkActivity.map(item => `<li>${item.url || item.domain || JSON.stringify(item)}</li>`).join('')}
            </ul>
        </div>`;
    }

    // 添加文件操作
    if (analysis.fileOperations && analysis.fileOperations.length > 0) {
        content += `
        <div style="margin: 15px 0;">
            <h4>文件操作 (${analysis.fileOperations.length}项)</h4>
            <ul>
                ${analysis.fileOperations.map(item => `<li>${item.path || item.operation || JSON.stringify(item)}</li>`).join('')}
            </ul>
        </div>`;
    }

    // 添加可疑模式
    if (analysis.suspiciousPatterns && analysis.suspiciousPatterns.length > 0) {
        content += `
        <div style="margin: 15px 0;">
            <h4>可疑模式 (${analysis.suspiciousPatterns.length}项)</h4>
            <ul>
                ${analysis.suspiciousPatterns.map(item => `<li>${item.description || item.name || JSON.stringify(item)}</li>`).join('')}
            </ul>
        </div>`;
    }

    // 添加安全建议
    content += `
        <div class="section-title">安全建议</div>
        <div style="background: #fffbe6; border: 1px solid #ffe58f; border-radius: 4px; padding: 20px; margin: 20px 0;">
            <ul>
                ${riskLevel === 'high' ? '<li><strong>高风险：</strong>立即隔离此文件，它包含恶意特征</li>' : ''}
                ${riskLevel === 'medium' ? '<li><strong>中风险：</strong>警告：文件包含可疑特征，建议进一步检查</li>' : ''}
                ${riskLevel === 'low' ? '<li><strong>低风险：</strong>文件风险较低，但仍建议保持警惕</li>' : ''}
                <li>定期更新杀毒软件病毒库</li>
                <li>不要打开来源不明的文件</li>
                <li>开启系统防火墙保护</li>
            </ul>
        </div>
    </div>
</body>
</html>`;

    return header + content;
}

/**
 * 清理AI报告内容，移除HTML骨架，只保留实际内容
 * @param {String} htmlContent - AI生成的HTML内容
 * @returns {String} 清理后的内容
 */
function cleanAIReportContent(htmlContent) {
    if (!htmlContent || typeof htmlContent !== 'string') {
        return htmlContent;
    }

    let cleaned = htmlContent;

    // 1. 移除 <!DOCTYPE ...>
    cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/i, '');

    // 2. 移除 <html> 开始标签（保留内容）
    cleaned = cleaned.replace(/<html[^>]*>/i, '');
    // 3. 移除 </html> 结束标签
    cleaned = cleaned.replace(/<\/html>/i, '');

    // 4. 移除 <head>...</head> 整个区块
    cleaned = cleaned.replace(/<head[\s\S]*?<\/head>/i, '');

    // 5. 移除 <body> 开始标签，但保留内容
    cleaned = cleaned.replace(/<body[^>]*>/i, '');
    // 6. 移除 </body> 结束标签
    cleaned = cleaned.replace(/<\/body>/i, '');

    // 7. 如果AI生成了report-container div，移除它
    // 查找常见的报告头部div，如 "report-header", "header", "file-info" 等
    // 但只匹配到第一个section之前的内容
    const headerPatterns = [
        /<div[^>]*class=["'][^"']*report-header[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
        /<div[^>]*class=["'][^"']*header[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
        /<div[^>]*class=["'][^"']*file-info[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
        /<header[^>]*>[\s\S]*?<\/header>/i,
    ];

    // 8. 尝试移除文件信息表格（包含文件名、文件大小等）
    // 匹配包含这些关键词的表格
    const fileInfoTablePattern = /<table[^>]*>[\s\S]*?(?:文件名|文件大小|文件类型|检测时间|File Name|File Size)[\s\S]*?<\/table>/i;
    cleaned = cleaned.replace(fileInfoTablePattern, '');

    // 9. 移除可能存在的标题和副标题（通常在开头）
    // 匹配包含 "安全检测"、"分析报告" 等字样的 h1/h2 标签
    const titlePatterns = [
        /<h1[^>]*>[\s\S]*?(?:安全检测|分析报告|Security|Report)[\s\S]*?<\/h1>/i,
        /<h2[^>]*>[\s\S]*?(?:文件信息|File Information)[\s\S]*?<\/h2>/i,
    ];
    titlePatterns.forEach(pattern => {
        cleaned = cleaned.replace(pattern, '');
    });

    // 10. 移除空的div容器（可能有class="container"、class="wrapper"等）
    // 但要注意不要移除包含实际内容的div
    cleaned = cleaned.replace(/<div[^>]*class=["'][^"']*(?:container|wrapper|main)[^"']*["'][^>]*>\s*(?=<)/i, '');

    // 11. 查找"执行摘要"或"1."作为内容起点
    // 如果内容中存在这些标记，移除它们之前的所有内容
    const contentStartMarkers = [
        '1. 【执行摘要】',
        '1. 执行摘要',
        '【执行摘要】',
        '执行摘要',
        '1. 【概述】',
        '1. 概述',
        '<h2',
        '<h3',
        '<div class="section"',
    ];

    for (const marker of contentStartMarkers) {
        const markerIndex = cleaned.indexOf(marker);
        if (markerIndex > 0) {
            // 找到标记，移除它之前的所有内容
            console.log(`[cleanAIReportContent] 找到内容起点标记: "${marker}" 在位置 ${markerIndex}`);
            cleaned = cleaned.substring(markerIndex);
            break;
        }
    }

    // 12. 清理多余的空白行和空格
    cleaned = cleaned.replace(/^\s+|\s+$/g, '');
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');

    console.log(`[cleanAIReportContent] 清理完成，原始长度: ${htmlContent.length}, 清理后长度: ${cleaned.length}`);
    return cleaned;
}

module.exports = router;
