const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

/**
 * Quickmu服务类 - 用于分析可执行文件
 */
class Quickmu {
    constructor() {
        this.uploadDir = process.env.UPLOAD_DIR || './uploads';
        this.analysisDir = process.env.QUICKMU_ANALYSIS_DIR || './quickmu-analysis';
        this.quarantineDir = process.env.QUARANTINE_DIR || './quarantine';

        // 确保分析目录存在
        if (!fs.existsSync(this.analysisDir)) {
            fs.mkdirSync(this.analysisDir, { recursive: true });
        }

        // 确保隔离目录存在
        if (!fs.existsSync(this.quarantineDir)) {
            fs.mkdirSync(this.quarantineDir, { recursive: true });
        }
    }

    /**
     * 分析可执行文件
     * @param {string} filePath - 可执行文件路径
     * @returns {Promise<Object>} 分析结果
     */
    async analyzeExecutable(filePath) {
        try {
            const fileStats = fs.statSync(filePath);
            const fileHash = this.calculateFileHash(filePath);

            // 基本信息收集
            const basicInfo = await this.collectBasicInfo(filePath);

            // 静态分析
            const staticAnalysis = await this.performStaticAnalysis(filePath);

            // 行为分析（在安全环境中）
            const behaviorAnalysis = await this.performBehaviorAnalysis(filePath);

            // 威胁检测
            const threatDetection = this.detectThreats(basicInfo, staticAnalysis, behaviorAnalysis);

            // 生成分析报告
            const analysisResult = {
                success: true,
                fileInfo: {
                    originalPath: filePath,
                    filename: path.basename(filePath),
                    size: fileStats.size,
                    hash: fileHash,
                    extension: path.extname(filePath).toLowerCase()
                },
                basicInfo: basicInfo,
                staticAnalysis: staticAnalysis,
                behaviorAnalysis: behaviorAnalysis,
                threatDetection: threatDetection,
                riskAssessment: this.assessRisk(basicInfo, staticAnalysis, behaviorAnalysis, threatDetection),
                timestamp: new Date().toISOString()
            };

            // 如果检测到高风险，移动到隔离区
            if (analysisResult.riskAssessment.riskLevel === 'high') {
                await this.quarantineFile(filePath, fileHash);
            }

            return analysisResult;

        } catch (error) {
            console.error('可执行文件分析失败:', error);
            return {
                success: false,
                error: error.message,
                fileInfo: {
                    originalPath: filePath,
                    filename: path.basename(filePath)
                },
                riskAssessment: {
                    riskLevel: 'unknown',
                    riskScore: 0,
                    verdict: '分析失败',
                    warnings: ['文件分析失败，可能为损坏或受保护文件']
                }
            };
        }
    }

    /**
     * 计算文件哈希值
     * @param {string} filePath - 文件路径
     * @returns {string} 文件哈希值
     */
    calculateFileHash(filePath) {
        try {
            const fileBuffer = fs.readFileSync(filePath);
            const hashSum = crypto.createHash('sha256');
            hashSum.update(fileBuffer);
            return hashSum.digest('hex');
        } catch (error) {
            console.error('计算文件哈希失败:', error);
            return 'unknown';
        }
    }

    /**
     * 收集基本信息
     * @param {string} filePath - 文件路径
     * @returns {Promise<Object>} 基本信息
     */
    async collectBasicInfo(filePath) {
        const info = {
            fileSize: 0,
            entropy: 0,
            fileType: 'unknown',
            signatures: [],
            packerInfo: null,
            digitalSignature: null
        };

        try {
            const stats = fs.statSync(filePath);
            info.fileSize = stats.size;

            // 计算熵值（随机性指标）
            info.entropy = this.calculateEntropy(filePath);

            // 文件类型检测
            info.fileType = this.detectFileType(filePath);

            // 检查数字签名（Windows）
            if (process.platform === 'win32') {
                info.digitalSignature = await this.checkDigitalSignature(filePath);
            }

            // 检测加壳信息
            info.packerInfo = this.detectPacker(filePath);

            // 收集文件签名
            info.signatures = this.collectSignatures(filePath);

        } catch (error) {
            console.error('收集基本信息失败:', error);
        }

        return info;
    }

    /**
     * 计算文件熵值
     * @param {string} filePath - 文件路径
     * @returns {number} 熵值
     */
    calculateEntropy(filePath) {
        try {
            const buffer = fs.readFileSync(filePath);
            const byteCounts = new Array(256).fill(0);

            // 统计每个字节的出现次数
            for (let i = 0; i < buffer.length; i++) {
                byteCounts[buffer[i]]++;
            }

            // 计算熵值
            let entropy = 0;
            const fileSize = buffer.length;

            for (let count of byteCounts) {
                if (count > 0) {
                    const probability = count / fileSize;
                    entropy -= probability * Math.log2(probability);
                }
            }

            return entropy;
        } catch (error) {
            console.error('计算熵值失败:', error);
            return 0;
        }
    }

    /**
     * 检测文件类型
     * @param {string} filePath - 文件路径
     * @returns {string} 文件类型
     */
    detectFileType(filePath) {
        try {
            const ext = path.extname(filePath).toLowerCase();
            const buffer = fs.readFileSync(filePath, { encoding: null, length: 64 });

            // PE文件检测
            if (buffer.length >= 2 && buffer[0] === 0x4D && buffer[1] === 0x5A) {
                return 'pe_executable';
            }

            // ELF文件检测
            if (buffer.length >= 4 && buffer[0] === 0x7F && buffer[1] === 0x45 &&
                buffer[2] === 0x4C && buffer[3] === 0x46) {
                return 'elf_executable';
            }

            // Mach-O文件检测
            if (buffer.length >= 4) {
                const magic = buffer.readUInt32BE(0);
                if (magic === 0xFEEDFACE || magic === 0xFEEDFACF ||
                    magic === 0xCEFAEDFE || magic === 0xCFFAEDFE) {
                    return 'macho_executable';
                }
            }

            // 基于扩展名的检测
            const extTypes = {
                '.exe': 'windows_executable',
                '.dll': 'windows_library',
                '.scr': 'windows_screen_saver',
                '.com': 'dos_executable',
                '.bat': 'batch_file',
                '.cmd': 'command_script',
                '.vbs': 'vbscript_file',
                '.ps1': 'powershell_script'
            };

            return extTypes[ext] || 'unknown_executable';
        } catch (error) {
            console.error('检测文件类型失败:', error);
            return 'unknown';
        }
    }

    /**
     * 检查数字签名（Windows）
     * @param {string} filePath - 文件路径
     * @returns {Promise<Object>} 签名信息
     */
    async checkDigitalSignature(filePath) {
        try {
            const { stdout } = await execAsync(`powershell -Command "Get-AuthenticodeSignature -FilePath '${filePath}' | Select-Object -Property Status, SignerCertificate, TimeStamperCertificate | ConvertTo-Json"`);
            return JSON.parse(stdout);
        } catch (error) {
            console.error('检查数字签名失败:', error);
            return { status: 'NotSigned', error: error.message };
        }
    }

    /**
     * 检测加壳信息
     * @param {string} filePath - 文件路径
     * @returns {Object} 加壳信息
     */
    detectPacker(filePath) {
        try {
            const buffer = fs.readFileSync(filePath, { encoding: null, length: 1024 });
            const packerSignatures = [
                { name: 'UPX', signature: 'UPX!' },
                { name: 'ASPack', signature: 'ASPack' },
                { name: 'PECompact', signature: 'PECompact' },
                { name: 'FSG', signature: 'FSG!' },
                { name: 'Themida', signature: 'WinLicense' }
            ];

            const packerInfo = {
                isPacked: false,
                packerName: null,
                confidence: 0
            };

            const fileContent = buffer.toString('ascii', 0, Math.min(buffer.length, 1024));

            for (const packer of packerSignatures) {
                if (fileContent.includes(packer.signature)) {
                    packerInfo.isPacked = true;
                    packerInfo.packerName = packer.name;
                    packerInfo.confidence = 80;
                    break;
                }
            }

            return packerInfo;
        } catch (error) {
            console.error('检测加壳信息失败:', error);
            return { isPacked: false, error: error.message };
        }
    }

    /**
     * 收集文件签名
     * @param {string} filePath - 文件路径
     * @returns {Array} 签名数组
     */
    collectSignatures(filePath) {
        const signatures = [];

        try {
            const buffer = fs.readFileSync(filePath, { encoding: null, length: 64 });

            // 检查已知的恶意签名模式（简化版）
            const maliciousPatterns = [
                { pattern: 'CreateRemoteThread', type: 'process_injection', severity: 'high' },
                { pattern: 'VirtualAllocEx', type: 'memory_manipulation', severity: 'high' },
                { pattern: 'WriteProcessMemory', type: 'memory_manipulation', severity: 'high' },
                { pattern: 'RegSetValueEx', type: 'registry_modification', severity: 'medium' },
                { pattern: 'CreateService', type: 'persistence', severity: 'high' },
                { pattern: 'URLDownloadToFile', type: 'download', severity: 'high' },
                { pattern: 'WinExec', type: 'execution', severity: 'medium' },
                { pattern: 'ShellExecute', type: 'execution', severity: 'medium' }
            ];

            const fileContent = buffer.toString('ascii', 0, Math.min(buffer.length, buffer.length));

            for (const pattern of maliciousPatterns) {
                if (fileContent.includes(pattern.pattern)) {
                    signatures.push({
                        pattern: pattern.pattern,
                        type: pattern.type,
                        severity: pattern.severity,
                        found: true
                    });
                }
            }

        } catch (error) {
            console.error('收集签名失败:', error);
        }

        return signatures;
    }

    /**
     * 执行静态分析
     * @param {string} filePath - 文件路径
     * @returns {Promise<Object>} 静态分析结果
     */
    async performStaticAnalysis(filePath) {
        const analysis = {
            imports: [],
            exports: [],
            sections: [],
            strings: [],
            suspiciousIndicators: []
        };

        try {
            // PE文件分析（简化版）
            if (this.detectFileType(filePath) === 'pe_executable') {
                analysis.sections = this.analyzePESections(filePath);
                analysis.imports = this.analyzePEImports(filePath);
                analysis.strings = this.extractStrings(filePath);
                analysis.suspiciousIndicators = this.findSuspiciousIndicators(analysis);
            }

        } catch (error) {
            console.error('静态分析失败:', error);
        }

        return analysis;
    }

    /**
     * 分析PE节区
     * @param {string} filePath - 文件路径
     * @returns {Array} 节区信息
     */
    analyzePESections(filePath) {
        const sections = [];

        try {
            const buffer = fs.readFileSync(filePath);

            // 简化的PE节区分析
            // 实际的PE分析需要解析PE头结构，这里只做基础检测
            if (buffer.length > 1024) {
                // 检查常见的恶意节区名称
                const suspiciousSectionNames = ['.text', '.data', '.rsrc', '.rdata'];
                const content = buffer.toString('ascii', 0, Math.min(buffer.length, 2048));

                for (const sectionName of suspiciousSectionNames) {
                    if (content.includes(sectionName)) {
                        sections.push({
                            name: sectionName,
                            found: true,
                            suspicious: false
                        });
                    }
                }
            }

        } catch (error) {
            console.error('分析PE节区失败:', error);
        }

        return sections;
    }

    /**
     * 分析PE导入表
     * @param {string} filePath - 文件路径
     * @returns {Array} 导入函数列表
     */
    analyzePEImports(filePath) {
        const imports = [];

        try {
            const buffer = fs.readFileSync(filePath, { encoding: null, length: 4096 });
            const content = buffer.toString('ascii', 0, Math.min(buffer.length, buffer.length));

            // 检查可疑的API调用
            const suspiciousAPIs = [
                'CreateRemoteThread', 'VirtualAllocEx', 'WriteProcessMemory',
                'RegSetValueEx', 'CreateService', 'URLDownloadToFile',
                'WinExec', 'ShellExecute', 'CreateProcess'
            ];

            for (const api of suspiciousAPIs) {
                if (content.includes(api)) {
                    imports.push({
                        function: api,
                        suspicious: true,
                        severity: 'high'
                    });
                }
            }

        } catch (error) {
            console.error('分析PE导入表失败:', error);
        }

        return imports;
    }

    /**
     * 提取字符串
     * @param {string} filePath - 文件路径
     * @returns {Array} 字符串列表
     */
    extractStrings(filePath) {
        const strings = [];

        try {
            const buffer = fs.readFileSync(filePath, { encoding: null, length: 10240 });
            const content = buffer.toString('ascii', 0, Math.min(buffer.length, buffer.length));

            // 提取可打印字符串
            const stringMatches = content.match(/[\x20-\x7E]{4,}/g);
            if (stringMatches) {
                strings.push(...stringMatches.slice(0, 50)); // 限制数量
            }

        } catch (error) {
            console.error('提取字符串失败:', error);
        }

        return strings;
    }

    /**
     * 查找可疑指标
     * @param {Object} analysis - 分析结果
     * @returns {Array} 可疑指标列表
     */
    findSuspiciousIndicators(analysis) {
        const indicators = [];

        // 检查导入函数
        for (const imp of analysis.imports) {
            if (imp.suspicious) {
                indicators.push({
                    type: 'suspicious_import',
                    detail: `可疑API调用: ${imp.function}`,
                    severity: imp.severity
                });
            }
        }

        // 检查字符串
        for (const str of analysis.strings) {
            const lowerStr = str.toLowerCase();
            if (lowerStr.includes('http://') || lowerStr.includes('https://')) {
                indicators.push({
                    type: 'url_in_string',
                    detail: `发现URL: ${str}`,
                    severity: 'medium'
                });
            }

            if (lowerStr.includes('cmd.exe') || lowerStr.includes('powershell')) {
                indicators.push({
                    type: 'shell_command',
                    detail: `发现shell命令: ${str}`,
                    severity: 'high'
                });
            }
        }

        return indicators;
    }

    /**
     * 执行行为分析
     * @param {string} filePath - 文件路径
     * @returns {Promise<Object>} 行为分析结果
     */
    async performBehaviorAnalysis(filePath) {
        const analysis = {
            simulated: true,
            networkActivity: [],
            fileActivity: [],
            registryActivity: [],
            processActivity: [],
            warnings: []
        };

        try {
            // 模拟行为分析（实际环境中需要在沙盒中运行）
            analysis.warnings.push('行为分析为模拟结果，实际环境中需要在隔离沙盒中执行');

            // 基于静态分析的预测
            const staticAnalysis = await this.performStaticAnalysis(filePath);

            // 预测可能的网络活动
            for (const str of staticAnalysis.strings) {
                if (str.includes('http://') || str.includes('https://')) {
                    analysis.networkActivity.push({
                        type: 'potential_connection',
                        url: str,
                        prediction: '可能尝试连接外部服务器'
                    });
                }
            }

            // 预测文件活动
            if (staticAnalysis.imports.some(imp => imp.function.includes('WriteFile'))) {
                analysis.fileActivity.push({
                    type: 'file_modification',
                    prediction: '可能修改系统文件'
                });
            }

            // 预测注册表活动
            if (staticAnalysis.imports.some(imp => imp.function.includes('Reg'))) {
                analysis.registryActivity.push({
                    type: 'registry_modification',
                    prediction: '可能修改注册表以实现持久化'
                });
            }

        } catch (error) {
            console.error('行为分析失败:', error);
            analysis.error = error.message;
        }

        return analysis;
    }

    /**
     * 威胁检测
     * @param {Object} basicInfo - 基本信息
     * @param {Object} staticAnalysis - 静态分析结果
     * @param {Object} behaviorAnalysis - 行为分析结果
     * @returns {Object} 威胁检测结果
     */
    detectThreats(basicInfo, staticAnalysis, behaviorAnalysis) {
        const threats = [];
        let threatScore = 0;

        // 基于熵值的检测
        if (basicInfo.entropy > 7.5) {
            threats.push({
                type: 'high_entropy',
                description: '文件熵值过高，可能经过加密或压缩',
                severity: 'medium',
                score: 20
            });
            threatScore += 20;
        }

        // 基于加壳的检测
        if (basicInfo.packerInfo && basicInfo.packerInfo.isPacked) {
            threats.push({
                type: 'packed_executable',
                description: `检测到加壳: ${basicInfo.packerInfo.packerName}`,
                severity: 'high',
                score: 40
            });
            threatScore += 40;
        }

        // 基于签名的检测
        if (basicInfo.signatures.length > 0) {
            for (const sig of basicInfo.signatures) {
                threats.push({
                    type: 'malicious_signature',
                    description: `检测到恶意签名: ${sig.pattern}`,
                    severity: sig.severity,
                    score: sig.severity === 'high' ? 50 : 30
                });
                threatScore += sig.severity === 'high' ? 50 : 30;
            }
        }

        // 基于静态分析的检测
        if (staticAnalysis.suspiciousIndicators.length > 0) {
            for (const indicator of staticAnalysis.suspiciousIndicators) {
                threats.push({
                    type: indicator.type,
                    description: indicator.detail,
                    severity: indicator.severity,
                    score: indicator.severity === 'high' ? 40 : 20
                });
                threatScore += indicator.severity === 'high' ? 40 : 20;
            }
        }

        // 基于网络活动的检测
        if (behaviorAnalysis.networkActivity.length > 0) {
            threats.push({
                type: 'network_activity',
                description: '检测到可能的网络通信行为',
                severity: 'high',
                score: 35
            });
            threatScore += 35;
        }

        return {
            threats: threats,
            threatScore: Math.min(threatScore, 100), // 限制在100以内
            threatLevel: this.getThreatLevel(threatScore)
        };
    }

    /**
     * 获取威胁等级
     * @param {number} score - 威胁分数
     * @returns {string} 威胁等级
     */
    getThreatLevel(score) {
        if (score >= 70) return 'high';
        if (score >= 40) return 'medium';
        if (score >= 20) return 'low';
        return 'minimal';
    }

    /**
     * 风险评估
     * @param {Object} basicInfo - 基本信息
     * @param {Object} staticAnalysis - 静态分析结果
     * @param {Object} behaviorAnalysis - 行为分析结果
     * @param {Object} threatDetection - 威胁检测结果
     * @returns {Object} 风险评估结果
     */
    assessRisk(basicInfo, staticAnalysis, behaviorAnalysis, threatDetection) {
        let riskScore = threatDetection.threatScore;
        let riskLevel = threatDetection.threatLevel;
        let verdict = 'Unknown';
        const warnings = [];

        // 基于多个因素调整风险评分
        if (basicInfo.entropy > 7.8) {
            riskScore += 10;
            warnings.push('文件熵值极高，可能经过重度混淆');
        }

        if (!basicInfo.digitalSignature || basicInfo.digitalSignature.status !== 'Valid') {
            riskScore += 15;
            warnings.push('文件缺乏有效的数字签名');
        }

        if (basicInfo.packerInfo && basicInfo.packerInfo.isPacked) {
            riskScore += 25;
            warnings.push('文件被加壳，可能试图逃避检测');
        }

        // 最终风险评估
        if (riskScore >= 80) {
            riskLevel = 'critical';
            verdict = '高度可疑 - 建议立即隔离';
        } else if (riskScore >= 60) {
            riskLevel = 'high';
            verdict = '高风险 - 建议阻止执行';
        } else if (riskScore >= 40) {
            riskLevel = 'medium';
            verdict = '中等风险 - 需要进一步分析';
        } else if (riskScore >= 20) {
            riskLevel = 'low';
            verdict = '低风险 - 监控执行';
        } else {
            riskLevel = 'minimal';
            verdict = '风险极低 - 相对安全';
        }

        return {
            riskScore: Math.min(riskScore, 100),
            riskLevel: riskLevel,
            verdict: verdict,
            warnings: warnings,
            recommendation: this.getRecommendation(riskLevel)
        };
    }

    /**
     * 获取建议
     * @param {string} riskLevel - 风险等级
     * @returns {string} 建议
     */
    getRecommendation(riskLevel) {
        const recommendations = {
            'critical': '立即隔离文件，阻止执行，进行深度分析',
            'high': '阻止文件执行，提交给专业安全团队分析',
            'medium': '在沙盒环境中进一步分析，监控网络活动',
            'low': '可以执行，但需要监控其行为',
            'minimal': '文件相对安全，可以正常执行'
        };

        return recommendations[riskLevel] || '需要进一步分析';
    }

    /**
     * 隔离文件
     * @param {string} filePath - 文件路径
     * @param {string} fileHash - 文件哈希
     * @returns {Promise<Object>} 隔离结果
     */
    async quarantineFile(filePath, fileHash) {
        try {
            const filename = path.basename(filePath);
            const quarantinePath = path.join(this.quarantineDir, `${fileHash}_${filename}`);

            // 复制文件到隔离区
            fs.copyFileSync(filePath, quarantinePath);

            // 删除原文件（可选）
            // fs.unlinkSync(filePath);

            return {
                success: true,
                quarantinePath: quarantinePath,
                message: '文件已隔离'
            };
        } catch (error) {
            console.error('隔离文件失败:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * 获取AI分析用的详细报告
     * @param {string} filePath - 可执行文件路径
     * @returns {Promise<Object>} 详细分析报告
     */
    async getDetailedAnalysis(filePath) {
        const result = await this.analyzeExecutable(filePath);

        if (!result.success) {
            return {
                tool: 'Quickmu',
                success: false,
                error: result.error,
                summary: '可执行文件分析失败',
                details: result
            };
        }

        return {
            tool: 'Quickmu',
            success: true,
            summary: `文件: ${result.fileInfo.filename} | 熵值: ${result.basicInfo.entropy.toFixed(2)} | 威胁分数: ${result.threatDetection.threatScore} | 风险等级: ${result.riskAssessment.riskLevel} | 裁决: ${result.riskAssessment.verdict}`,
            details: result,
            threatIndicators: result.threatDetection.threats.map(threat => ({
                type: threat.type,
                description: threat.description,
                severity: threat.severity,
                score: threat.score
            }))
        };
    }
}

module.exports = Quickmu;