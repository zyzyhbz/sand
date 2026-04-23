/**
 * 统一格式适配器 - 将不同分析工具的输出转换为统一格式
 * 专门为 DeepSeek AI 分析优化
 */
class FormatNormalizer {
    constructor() {
        // 统一的风险等级映射
        this.riskLevelMapping = {
            // 高风险
            high: 'high',
            critical: 'high',
            danger: 'high',
            // 中风险
            medium: 'medium',
            moderate: 'medium',
            warning: 'medium',
            // 低风险
            low: 'low',
            info: 'low',
            // 安全/未知
            safe: 'safe',
            unknown: 'unknown',
            error: 'unknown'
        };
    }

    /**
     * 主转换函数 - 根据工具类型选择对应的转换方法
     * @param {string} toolName - 分析工具名称 (EmailAnalyzer, Quickmu, MalwareJail)
     * @param {Object} result - 原始分析结果
     * @returns {Object} 统一格式的分析结果
     */
    normalize(toolName, result) {
        const normalizedResult = {
            metadata: {
                tool: toolName,
                timestamp: result.timestamp || new Date().toISOString(),
                success: result.success !== false,
                fileType: this.detectFileType(result),
                fileName: this.extractFileName(result)
            },
            riskAssessment: {
                overallRiskLevel: 'unknown',
                riskScore: 0,
                confidence: 'medium',
                verdict: '待分析'
            },
            analysis: {
                maliciousBehavior: [],
                networkActivity: [],
                fileOperations: [],
                urls: [],
                suspiciousPatterns: [],
                indicators: []
            },
            details: {},
            suggestions: []
        };

        // 根据工具类型进行转换
        try {
            switch (toolName) {
                case 'EmailAnalyzer':
                    return this.normalizeEmailAnalyzer(result);
                case 'Quickmu':
                    return this.normalizeQuickmu(result);
                case 'MalwareJail':
                    return this.normalizeMalwareJail(result);
                case 'Sandbox':
                    return this.normalizeSandbox(result);
                default:
                    console.warn(`未知的工具类型: ${toolName}`);
                    return normalizedResult;
            }
        } catch (error) {
            console.error(`格式化失败 (${toolName}):`, error);
            normalizedResult.metadata.success = false;
            normalizedResult.metadata.error = error.message;
            return normalizedResult;
        }
    }

    /**
     * 转换 EmailAnalyzer 的输出
     */
    normalizeEmailAnalyzer(result) {
        if (!result.success) {
            return this.createErrorResult('EmailAnalyzer', result.error);
        }

        const normalized = this.createBaseResult('EmailAnalyzer', result);

        // 风险评估
        normalized.riskAssessment = {
            overallRiskLevel: this.mapRiskLevel(result.securityFlags?.riskLevel),
            riskScore: this.calculateRiskScore(result.securityFlags),
            confidence: 'medium',
            verdict: this.generateVerdictEmail(result),
            hasAttachments: result.attachments && result.attachments.length > 0,
            attachmentCount: result.attachments?.length || 0,
            suspiciousContent: result.securityFlags?.hasSuspiciousContent || false
        };

        // 添加 riskLevel 到 analysis 对象，使前端可以正确显示风险等级
        normalized.analysis.riskLevel = normalized.riskAssessment.overallRiskLevel;

        // 分析结果
        normalized.analysis.maliciousBehavior = result.securityFlags?.warnings?.map(warning => ({
            type: 'email_warning',
            description: warning,
            severity: this.classifySeverity(warning),
            category: 'malicious_behavior'
        })) || [];

        normalized.analysis.urls = this.extractUrls(result.emailInfo?.body || '');

        normalized.analysis.fileOperations = result.attachments?.map(att => ({
            type: 'attachment',
            description: `附件: ${att.filename}`,
            details: {
                filename: att.filename,
                size: att.size,
                contentType: att.contentType,
                extracted: att.extracted,
                path: att.path
            },
            severity: this.classifyAttachmentSeverity(att),
            category: 'file_operation'
        })) || [];

        normalized.analysis.suspiciousPatterns = result.securityFlags?.suspiciousPatterns?.map(pattern => ({
            type: 'suspicious_pattern',
            description: pattern,
            severity: 'medium',
            category: 'suspicious_pattern'
        })) || [];

        // 详细信息
        normalized.details = {
            emailInfo: result.emailInfo,
            rawContent: result.rawContent?.substring(0, 2000),
            attachmentsInfo: result.attachments
        };

        // 建议和警告
        normalized.suggestions = this.generateEmailSuggestions(result);

        return normalized;
    }

    /**
     * 转换 Quickmu 的输出
     */
    normalizeQuickmu(result) {
        if (!result.success) {
            return this.createErrorResult('Quickmu', result.error);
        }

        const normalized = this.createBaseResult('Quickmu', result);

        // 风险评估
        normalized.riskAssessment = {
            overallRiskLevel: this.mapRiskLevel(result.riskAssessment?.riskLevel),
            riskScore: result.riskAssessment?.riskScore || 0,
            confidence: 'high',
            verdict: result.riskAssessment?.verdict || '待分析',
            threatCount: result.threatDetection?.threats?.length || 0,
            entropy: result.basicInfo?.entropy || 0,
            isPacked: result.basicInfo?.packerInfo?.isPacked || false
        };

        // 静态分析
        normalized.analysis.indicators = result.basicInfo?.signatures?.map(sig => ({
            type: 'signature',
            description: sig,
            category: 'static_analysis',
            severity: 'medium'
        })) || [];

        // 威胁检测
        normalized.analysis.maliciousBehavior = result.threatDetection?.threats?.map(threat => ({
            type: threat.type || 'threat',
            description: threat.description || '检测到威胁',
            severity: this.mapThreatSeverity(threat.severity),
            category: 'threat_detection',
            score: threat.score
        })) || [];

        // 行为分析
        if (result.behaviorAnalysis) {
            Object.entries(result.behaviorAnalysis).forEach(([key, value]) => {
                if (value && value.length > 0) {
                    this.addBehaviorToAnalysis(normalized.analysis, key, value);
                }
            });
        }

        // URL和网络活动
        if (result?.staticAnalysis?.urls) {
            normalized.analysis.urls = result.staticAnalysis.urls.map(url => ({
                url: url,
                category: 'network'
            }));
        }

        // 详细信息
        normalized.details = {
            fileInfo: result.fileInfo,
            basicInfo: result.basicInfo,
            staticAnalysis: result.staticAnalysis,
            behaviorAnalysis: result.behaviorAnalysis,
            threatDetection: result.threatDetection
        };

        // 添加 riskLevel 到 analysis 对象,使前端可以正确显示风险等级
        normalized.analysis.riskLevel = normalized.riskAssessment.overallRiskLevel;

        // 建议和警告
        normalized.suggestions = this.generateQuickmuSuggestions(result);

        return normalized;
    }

    /**
     * 转换 MalwareJail/Sandbox 的输出
     */
    normalizeMalwareJail(result) {
        if (!result.success) {
            return this.createErrorResult('MalwareJail', result.error);
        }

        const normalized = this.createBaseResult('MalwareJail', result);

        // 从 analysis 或 details 中提取分析结果
        const analysisData = result.analysis || [];

        // 风险评估
        normalized.riskAssessment = {
            overallRiskLevel: this.calculateSandboxRiskLevel(analysisData),
            riskScore: this.calculateSandboxRiskScore(analysisData),
            confidence: 'high',
            verdict: this.generateSandboxVerdict(analysisData)
        };

        // 解析分析结果
        if (Array.isArray(analysisData)) {
            analysisData.forEach(item => {
                this.addSandboxAnalysisItem(normalized.analysis, item);
            });
        } else if (typeof analysisData === 'object' && analysisData !== null) {
            // 处理对象类型的分析结果
            this.processObjectAnalysis(normalized.analysis, analysisData);
        }

        // URL 提取
        this.extractSandboxUrls(normalized.analysis, result.stdout || '');

        // 详细信息
        normalized.details = {
            fileType: result.fileType,
            stdout: result.stdout?.substring(0, 2000) || '',
            stderr: result.stderr?.substring(0, 500) || '',
            error: result.error,
            partialResults: analysisData.partialResults
        };

        // 添加 riskLevel 到 analysis 对象，使前端可以正确显示风险等级
        normalized.analysis.riskLevel = normalized.riskAssessment.overallRiskLevel;

        // 建议和警告
        normalized.suggestions = this.generateSandboxSuggestions(analysisData);

        return normalized;
    }

    /**
     * 转换 Sandbox 服务的输出（MalwareJail的别名）
     */
    normalizeSandbox(result) {
        return this.normalizeMalwareJail(result);
    }

    /**
     * 创建基础结果结构
     */
    createBaseResult(toolName, result) {
        return {
            metadata: {
                tool: toolName,
                timestamp: result.timestamp || new Date().toISOString(),
                success: result.success !== false,
                fileType: this.detectFileType(result),
                fileName: this.extractFileName(result)
            },
            riskAssessment: {
                overallRiskLevel: 'unknown',
                riskScore: 0,
                confidence: 'medium',
                verdict: '待分析'
            },
            analysis: {
                maliciousBehavior: [],
                networkActivity: [],
                fileOperations: [],
                urls: [],
                suspiciousPatterns: [],
                indicators: []
            },
            details: {},
            suggestions: []
        };
    }

    /**
     * 创建错误结果
     */
    createErrorResult(toolName, error) {
        return {
            metadata: {
                tool: toolName,
                timestamp: new Date().toISOString(),
                success: false,
                error: error || '分析失败'
            },
            riskAssessment: {
                overallRiskLevel: 'unknown',
                riskScore: 0,
                confidence: 'low',
                verdict: '分析失败，无法评估风险'
            },
            analysis: {
                maliciousBehavior: [],
                networkActivity: [],
                fileOperations: [],
                urls: [],
                suspiciousPatterns: [],
                indicators: [{
                    type: 'error',
                    description: `分析失败: ${error}`,
                    severity: 'high',
                    category: 'system_error'
                }]
            },
            details: {
                error: error,
                errorMessage: `工具 ${toolName} 分析时发生错误`
            },
            suggestions: [
                '检查文件是否损坏或格式是否正确',
                '重试分析',
                '如果问题持续存在，请联系管理员'
            ]
        };
    }

    /**
     * 从工具特定的分析结果中计算总风险分数
     * @param {Array} toolResults - 多个工具的分析结果数组
     * @returns {Object} 综合风险评估
     */
    aggregateRiskAssessment(toolResults) {
        const validResults = toolResults.filter(r => r && r.success !== false);

        if (validResults.length === 0) {
            return {
                overallRiskLevel: 'unknown',
                riskScore: 0,
                confidence: 'low',
                verdict: '所有分析工具均失败，无法评估风险',
                toolCount: 0,
                successfulTools: []
            };
        }

        // 收集所有风险等级和分数
        const riskLevels = validResults.map(r => r.riskAssessment?.overallRiskLevel || 'unknown');
        const riskScores = validResults.map(r => r.riskAssessment?.riskScore || 0);

        // 计算平均风险分数
        const avgRiskScore = Math.round(riskScores.reduce((a, b) => a + b, 0) / riskScores.length);

        // 确定整体风险等级（取最高）
        const riskPriority = ['safe', 'low', 'medium', 'high'];
        const highestRisk = riskLevels.reduce((highest, current) => {
            return riskPriority.indexOf(current) > riskPriority.indexOf(highest) ? current : highest;
        });

        // 计算信心度（基于成功分析的工具数量）
        const confidence = validResults.length >= 3 ? 'high' :
            validResults.length >= 2 ? 'medium' : 'low';

        // 综合裁决
        const verdict = this.generateAggregatedVerdict(highestRisk, avgRiskScore, validResults.length);

        return {
            overallRiskLevel: highestRisk,
            riskScore: avgRiskScore,
            confidence: confidence,
            verdict: verdict,
            toolCount: toolResults.length,
            successCount: validResults.length,
            successfulTools: validResults.map(r => r.metadata?.tool)
        };
    }

    /**
     * 合并多个工具的分析结果
     * @param {Array} toolResults - 多个工具的分析结果数组
     * @returns {Object} 合并后的统一分析结果
     */
    mergeAnalysisResults(toolResults) {
        const validResults = toolResults.filter(r => r && r.success !== false);

        // 收集所有分析数据
        const mergedAnalysis = {
            maliciousBehavior: [],
            networkActivity: [],
            fileOperations: [],
            urls: [],
            suspiciousPatterns: [],
            indicators: []
        };

        validResults.forEach(result => {
            if (result.analysis) {
                Object.keys(mergedAnalysis).forEach(key => {
                    if (Array.isArray(result.analysis[key])) {
                        mergedAnalysis[key].push(...result.analysis[key]);
                    }
                });
            }
        });

        // 去重 URL
        mergedAnalysis.urls = this.deduplicateUrls(mergedAnalysis.urls);

        // 统计行为数量
        const behaviorCounts = {
            maliciousBehavior: mergedAnalysis.maliciousBehavior.length,
            networkActivity: mergedAnalysis.networkActivity.length,
            fileOperations: mergedAnalysis.fileOperations.length,
            suspiciousPatterns: mergedAnalysis.suspiciousPatterns.length
        };

        // 综合建议
        const allSuggestions = validResults.flatMap(r => r.suggestions || []);
        const uniqueSuggestions = [...new Set(allSuggestions)];

        return {
            behaviorCounts,
            mergedAnalysis,
            suggestionCount: uniqueSuggestions.length,
            uniqueSuggestions
        };
    }

    // ==================== 辅助方法 ====================

    /**
     * 映射风险等级
     */
    mapRiskLevel(level) {
        return this.riskLevelMapping[level?.toLowerCase()] || 'unknown';
    }

    /**
     * 将严重性映射到标准等级
     */
    mapThreatSeverity(severity) {
        if (!severity) return 'medium';
        const s = severity.toLowerCase();
        if (['critical', 'high', 'danger'].includes(s)) return 'high';
        if (['low', 'info'].includes(s)) return 'low';
        return 'medium';
    }

    /**
     * 分类消息严重性
     */
    classifySeverity(message) {
        const highKeywords = ['恶意', '病毒', '木马', '危险', '攻击', 'exploit', 'malware'];
        const lowKeywords = ['警告', '注意', '可能', 'could', 'potential'];

        const msg = message.toLowerCase();
        if (highKeywords.some(kw => msg.includes(kw))) return 'high';
        if (lowKeywords.some(kw => msg.includes(kw))) return 'low';
        return 'medium';
    }

    /**
     * 分类附件严重性
     */
    classifyAttachmentSeverity(attachment) {
        const dangerousExts = ['.exe', '.bat', '.cmd', '.scr', '.pif', '.com', '.js', '.vbs'];
        const ext = attachment.filename?.toLowerCase().split('.').pop();

        if (dangerousExts.includes(`.${ext}`)) return 'high';
        if (attachment.size > 1024 * 1024) return 'medium'; // > 1MB
        return 'low';
    }

    /**
     * 提取 URL
     */
    extractUrls(text) {
        const urlRegex = /https?:\/\/[^\s\'\"<>]+/gi;
        const urls = text.match(urlRegex) || [];
        return [...new Set(urls)].map(url => ({
            url: url,
            category: 'email_content'
        }));
    }

    /**
     * URL 去重
     */
    deduplicateUrls(urls) {
        const seen = new Set();
        return urls.filter(u => {
            const urlStr = typeof u === 'string' ? u : u.url;
            if (seen.has(urlStr)) return false;
            seen.add(urlStr);
            return true;
        });
    }

    /**
     * 检测文件类型
     */
    detectFileType(result) {
        if (result.fileInfo?.filename) {
            const ext = result.fileInfo.filename.split('.').pop().toLowerCase();
            return ext;
        }
        if (result.filePath) {
            const ext = result.filePath.split('.').pop().toLowerCase();
            return ext;
        }
        return 'unknown';
    }

    /**
     * 提取文件名
     */
    extractFileName(result) {
        if (result.fileInfo?.filename) return result.fileInfo.filename;
        if (result.emailInfo?.subject) return `邮件: ${result.emailInfo.subject}`;
        if (result.filePath) return result.filePath.split('/').pop();
        return '未知文件';
    }

    /**
     * 计算风险分数（EmailAnalyzer）
     */
    calculateRiskScore(securityFlags) {
        let score = 0;
        if (!securityFlags) return score;

        if (securityFlags.hasSuspiciousContent) score += 30;
        if (securityFlags.hasAttachments) score += 20;
        if (securityFlags.warnings?.length > 0) score += 10 * securityFlags.warnings.length;
        if (securityFlags.suspiciousPatterns?.length > 0) score += 15 * securityFlags.suspiciousPatterns.length;

        return Math.min(score, 100);
    }

    /**
     * 计算沙盒风险等级
     */
    calculateSandboxRiskLevel(analysisData) {
        if (!analysisData) return 'unknown';

        const maliciousCount = Array.isArray(analysisData.maliciousBehavior) ?
            analysisData.maliciousBehavior.length : 0;
        const suspiciousCount = Array.isArray(analysisData.suspiciousPatterns) ?
            analysisData.suspiciousPatterns.length : 0;

        if (maliciousCount > 0) return 'high';
        if (suspiciousCount >= 3) return 'high';
        if (suspiciousCount > 0) return 'medium';
        return 'safe';
    }

    /**
     * 计算沙盒风险分数
     */
    calculateSandboxRiskScore(analysisData) {
        let score = 0;
        if (!analysisData) return score;

        if (analysisData.maliciousBehavior?.length > 0) score += 50;
        if (analysisData.networkActivity?.length > 0) score += 30;
        if (analysisData.fileOperations?.length > 0) score += 20;
        if (analysisData.suspiciousPatterns?.length > 0) score += 15 * analysisData.suspiciousPatterns.length;

        return Math.min(score, 100);
    }

    /**
     * 添加行为到分析结果
     */
    addBehaviorToAnalysis(analysis, key, value) {
        const categoryMap = {
            network: 'networkActivity',
            file: 'fileOperations',
            registry: 'fileOperations',
            process: 'maliciousBehavior'
        };

        const targetCategory = categoryMap[key] || 'suspiciousPatterns';

        if (Array.isArray(value)) {
            value.forEach(item => {
                analysis[targetCategory].push({
                    type: key,
                    description: typeof item === 'string' ? item : JSON.stringify(item),
                    severity: 'medium',
                    category: key
                });
            });
        }
    }

    /**
     * 添加沙盒分析项
     */
    addSandboxAnalysisItem(analysis, item) {
        if (!item || typeof item !== 'object') return;

        if (item.type === 'malicious' || item.type === 'network' || item.type === 'file') {
            const targetCategory = item.type === 'malicious' ? 'maliciousBehavior' :
                item.type === 'network' ? 'networkActivity' : 'fileOperations';

            analysis[targetCategory].push({
                type: item.type,
                description: typeof item.details === 'string' ? item.details : JSON.stringify(item.details),
                severity: item.type === 'malicious' ? 'high' : 'medium',
                category: 'sandbox_detection'
            });
        }
    }

    /**
     * 处理对象类型的分析结果
     */
    processObjectAnalysis(analysis, data) {
        Object.entries(data).forEach(([key, value]) => {
            if (Array.isArray(value) && value.length > 0) {
                value.forEach(item => {
                    const categoryMap = {
                        maliciousBehavior: 'maliciousBehavior',
                        networkActivity: 'networkActivity',
                        fileOperations: 'fileOperations',
                        urls: 'urls',
                        suspiciousPatterns: 'suspiciousPatterns'
                    };

                    const targetCategory = categoryMap[key] || 'suspiciousPatterns';
                    analysis[targetCategory].push({
                        type: key,
                        description: typeof item === 'string' ? item : JSON.stringify(item),
                        severity: key === 'maliciousBehavior' ? 'high' : 'medium',
                        category: 'sandbox'
                    });
                });
            }
        });
    }

    /**
     * 从沙盒输出中提取 URL
     */
    extractSandboxUrls(analysis, output) {
        const urlRegex = /https?:\/\/[^\s\'\"<>]+/gi;
        const urls = output.match(urlRegex) || [];
        urls.forEach(url => {
            if (!analysis.urls.some(u => (u.url || u) === url)) {
                analysis.urls.push({
                    url: url,
                    category: 'sandbox_execution'
                });
            }
        });
    }

    // ==================== 建议生成方法 ====================

    generateVerdictEmail(result) {
        const riskCount = (result.securityFlags?.warnings?.length || 0) +
            (result.securityFlags?.suspiciousPatterns?.length || 0);

        if (riskCount > 3) return '高风险邮件，建议立即隔离并详细检查';
        if (riskCount > 0) return '检测到可疑内容，建议谨慎处理';
        if (result.attachments?.length > 0) return '邮件包含附件，建议扫描后打开';
        return '邮件无明显恶意特征';
    }

    generateEmailSuggestions(result) {
        const suggestions = [];

        if (result.securityFlags?.hasSuspiciousContent) {
            suggestions.push('邮件内容包含可疑特征，建议不要点击链接或下载附件');
        }
        if (result.attachments?.length > 0) {
            suggestions.push('邮件包含附件，建议使用安全环境分析后再打开');
        }
        if (result.securityFlags?.warnings?.length > 0) {
            suggestions.push('检测到安全警告，建议验证发件人身份');
        }

        if (suggestions.length === 0) {
            suggestions.push('邮件安全性评估完成，未发现明显威胁');
        }

        return suggestions;
    }

    generateQuickmuSuggestions(result) {
        const suggestions = [];

        if (result.threatDetection?.threats?.length > 0) {
            suggestions.push(`检测到 ${result.threatDetection.threats.length} 个威胁指标，建议隔离文件`);
        }
        if (result.basicInfo?.packerInfo?.isPacked) {
            suggestions.push('文件经过加壳处理，可能隐藏恶意代码');
        }
        if (result.basicInfo?.entropy > 7) {
            suggestions.push('文件熵值较高，可能被加密或混淆');
        }
        if (result.riskAssessment?.riskLevel === 'high') {
            suggestions.push('高风险文件，建议不要在非隔离环境中执行');
        }

        return suggestions;
    }

    generateSandboxVerdict(analysisData) {
        const maliciousCount = Array.isArray(analysisData.maliciousBehavior) ?
            analysisData.maliciousBehavior.length : 0;

        if (maliciousCount > 0) return '检测到恶意行为，建议立即隔离';
        if (analysisData.suspiciousPatterns?.length > 2) return '检测到可疑行为，建议谨慎处理';
        return '文件分析完成，未检测到明显恶意行为';
    }

    generateSandboxSuggestions(analysisData) {
        const suggestions = [];

        if (analysisData.maliciousBehavior?.length > 0) {
            suggestions.push('文件检测到恶意行为，建议隔离');
        }
        if (analysisData.networkActivity?.length > 0) {
            suggestions.push('检测到网络活动，建议检查目标地址');
        }
        if (analysisData.fileOperations?.length > 0) {
            suggestions.push('检测到文件系统操作，建议监控相关路径');
        }

        return suggestions;
    }

    generateAggregatedVerdict(highestRisk, avgScore, toolCount) {
        if (highestRisk === 'high') {
            return `多工具分析显示高风险（${toolCount}个工具，平均分数: ${avgScore}），建议立即隔离`;
        }
        if (highestRisk === 'medium') {
            return `检测到中等风险（${toolCount}个工具，平均分数: ${avgScore}），建议谨慎处理`;
        }
        return `综合分析结果安全（${toolCount}个工具，平均分数: ${avgScore}）`;
    }
}

module.exports = FormatNormalizer;