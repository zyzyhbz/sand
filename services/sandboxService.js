const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);

class SandboxService {
    constructor() {
        this.malwareJailPath = process.env.MALWAREJAIL_PATH || './malware-jail';
        this.outputPath = process.env.MALWAREJAIL_OUTPUT_PATH || './malware-jail/output';
    }

    /**
     * 在沙盒中执行文件分析
     * @param {string} filePath - 要分析的文件路径
     * @param {string} fileType - 文件类型（js, html等）
     */
    async analyzeFile(filePath, fileType = 'auto') {
        let tempFilePath = null;
        try {
            console.log(`[沙盒] 开始分析文件: ${filePath}`);

            // 验证文件是否存在
            if (!fs.existsSync(filePath)) {
                throw new Error('文件不存在');
            }

            // 获取原始文件名并清理特殊字符
            const originalFilename = path.basename(filePath);
            const cleanFilename = originalFilename.replace(/[^a-zA-Z0-9.-]/g, '_');

            // 如果文件名太长或包含特殊字符，创建临时文件
            if (originalFilename !== cleanFilename || originalFilename.length > 30) {
                const tempDir = path.join(__dirname, '../malware-jail/temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }

                // 进一步简化文件名 - 只保留基本名称和时间戳
                const fileExt = path.extname(cleanFilename);
                const baseName = path.basename(cleanFilename, fileExt);
                const simpleName = baseName.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '');
                tempFilePath = path.join(tempDir, `temp_${Date.now()}_${simpleName}${fileExt}`);

                console.log(`[沙盒] 创建临时文件: ${tempFilePath}`);
                fs.copyFileSync(filePath, tempFilePath);
            } else {
                tempFilePath = filePath;
            }

            // 根据文件类型配置沙盒
            let configPath = path.join(this.malwareJailPath, 'config.json');

            // 对于特定文件类型使用不同的配置
            if (fileType === 'wscript') {
                configPath = path.join(this.malwareJailPath, 'config_wscript_only.json');
            } else if (fileType === 'fileexists') {
                configPath = path.join(this.malwareJailPath, 'config_wscript_fileexists.json');
            }

            // 构建沙盒命令 - 转换为绝对路径
            const jailmePath = path.resolve(__dirname, '../malware-jail/jailme.js');
            const absFilePath = path.resolve(tempFilePath);

            console.log(`[沙盒] Jailme路径: ${jailmePath}`);
            console.log(`[沙盒] 文件绝对路径: ${absFilePath}`);

            // 尝试不使用配置文件参数，让MalwareJail使用默认配置
            const command = `node "${jailmePath}" "${absFilePath}"`;

            console.log(`[沙盒] 执行命令: ${command}`);

            // 执行沙盒分析 - 设置工作目录为malware-jail目录
            const { stdout, stderr } = await execPromise(command, {
                timeout: 60000, // 60秒超时
                windowsHide: true, // 隐藏子进程窗口
                cwd: path.join(__dirname, '../malware-jail') // 设置工作目录
            });

            console.log(`[沙盒] 分析完成`);

            // 解析分析结果
            const results = await this.parseAnalysisResults(filePath);

            return {
                success: true,
                filePath: filePath,
                fileType: fileType,
                timestamp: new Date().toISOString(),
                stdout: stdout,
                stderr: stderr,
                analysis: results
            };

        } catch (error) {
            console.error('[沙盒] 分析失败:', error);

            // 即使MalwareJail失败，也尝试从错误输出中提取有用信息
            let partialAnalysis = null;
            try {
                // 从错误消息中提取信息
                const errorInfo = {
                    maliciousBehavior: [],
                    networkActivity: [],
                    fileOperations: [],
                    urls: [],
                    suspiciousPatterns: [],
                    riskLevel: 'unknown',
                    partialResults: true,
                    errorDetails: error.message
                };

                // 如果错误对象包含stdout，从中提取信息
                if (error.stdout) {
                    // 提取已执行的代码信息
                    if (error.stdout.includes('ActiveXObject')) {
                        errorInfo.maliciousBehavior.push('尝试创建ActiveX对象');
                    }
                    if (error.stdout.includes('WScript.Shell')) {
                        errorInfo.maliciousBehavior.push('使用WScript.Shell执行命令');
                    }
                    if (error.stdout.includes('Microsoft.XMLHTTP')) {
                        errorInfo.networkActivity.push('尝试创建XMLHTTP对象进行网络通信');
                    }
                    if (error.stdout.includes('cmd.exe')) {
                        errorInfo.maliciousBehavior.push('尝试执行系统命令');
                    }
                }

                // 设置风险等级
                if (errorInfo.maliciousBehavior.length > 0) {
                    errorInfo.riskLevel = 'high';
                } else {
                    errorInfo.riskLevel = 'medium';
                }

                partialAnalysis = errorInfo;
            } catch (parseError) {
                console.warn('[沙盒] 无法解析部分结果:', parseError.message);
            }

            return {
                success: true, // 标记为成功，因为我们有有用的分析信息
                filePath: filePath,
                fileType: fileType,
                error: `MalwareJail分析失败: ${error.message}`,
                timestamp: new Date().toISOString(),
                analysis: partialAnalysis || {
                    maliciousBehavior: ['脚本执行失败，可能包含恶意代码'],
                    networkActivity: [],
                    fileOperations: [],
                    urls: [],
                    suspiciousPatterns: ['执行过程中发生错误'],
                    riskLevel: 'high',
                    partialResults: true,
                    errorDetails: error.message
                }
            };
        } finally {
            // 清理临时文件
            if (tempFilePath && tempFilePath !== filePath) {
                try {
                    fs.unlinkSync(tempFilePath);
                    console.log(`[沙盒] 清理临时文件: ${tempFilePath}`);
                } catch (cleanupError) {
                    console.warn(`[沙盒] 清理临时文件失败: ${cleanupError.message}`);
                }
            }
        }
    }

    /**
     * 解析沙盒分析结果
     * @param {string} filePath - 原始文件路径
     */
    async parseAnalysisResults(filePath) {
        try {
            let results = {
                maliciousBehavior: [],
                networkActivity: [],
                fileOperations: [],
                urls: [],
                suspiciousPatterns: [],
                riskLevel: 'unknown'
            };

            // 生成输出文件名（基于文件哈希或名称）
            const fileName = path.basename(filePath);
            const possibleOutputFiles = [
                path.join(this.outputPath, `${fileName}.out`),
                path.join(this.outputPath, `${fileName}.output`),
                path.join(this.outputPath, `${fileName}.json`)
            ];

            // 查找并读取输出文件
            let outputContent = '';
            for (const outputFile of possibleOutputFiles) {
                if (fs.existsSync(outputFile)) {
                    outputContent = fs.readFileSync(outputFile, 'utf-8');
                    console.log(`[沙盒] 读取输出文件: ${outputFile}`);
                    break;
                }
            }

            // 如果没有找到输出文件，检查malware-jail/output目录下的最新文件
            if (!outputContent && fs.existsSync(this.outputPath)) {
                const files = fs.readdirSync(this.outputPath);
                const recentFiles = files
                    .filter(f => f.endsWith('.out') || f.endsWith('.output') || f.endsWith('.json'))
                    .map(f => ({
                        name: f,
                        time: fs.statSync(path.join(this.outputPath, f)).mtime.getTime()
                    }))
                    .sort((a, b) => b.time - a.time);

                if (recentFiles.length > 0) {
                    const recentFile = path.join(this.outputPath, recentFiles[0].name);
                    outputContent = fs.readFileSync(recentFile, 'utf-8');
                    console.log(`[沙盒] 读取最新输出文件: ${recentFile}`);
                }
            }

            // 解析输出内容
            if (outputContent) {
                results = this.parseOutputContent(outputContent);
            }

            return results;

        } catch (error) {
            console.error('[沙盒] 解析结果失败:', error);
            return {
                maliciousBehavior: [],
                networkActivity: [],
                fileOperations: [],
                urls: [],
                suspiciousPatterns: [],
                riskLevel: 'error',
                error: error.message
            };
        }
    }

    /**
     * 解析输出内容
     * @param {string} content - 输出内容
     */
    parseOutputContent(content) {
        const results = {
            maliciousBehavior: [],
            networkActivity: [],
            fileOperations: [],
            urls: [],
            suspiciousPatterns: [],
            riskLevel: 'unknown'
        };

        try {
            // 尝试解析为JSON
            if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
                const jsonData = JSON.parse(content);

                // 提取URL
                if (jsonData.urls) {
                    results.urls = Array.isArray(jsonData.urls) ? jsonData.urls : [jsonData.urls];
                }

                // 提取网络活动
                if (jsonData.network || jsonData.requests) {
                    results.networkActivity.push({
                        type: 'network',
                        details: jsonData.network || jsonData.requests
                    });
                }

                // 提取文件操作
                if (jsonData.files || jsonData.fileOperations) {
                    results.fileOperations.push({
                        type: 'file',
                        details: jsonData.files || jsonData.fileOperations
                    });
                }

                // 提取恶意行为
                if (jsonData.malicious || jsonData.threats) {
                    results.maliciousBehavior.push({
                        type: 'malicious',
                        details: jsonData.malicious || jsonData.threats
                    });
                }

                // 评估风险等级
                results.riskLevel = this.assessRiskLevel(results);

                return results;
            }
        } catch (e) {
            console.log('[沙盒] 不是JSON格式，按文本解析');
        }

        // 文本解析
        const lines = content.split('\n');

        for (const line of lines) {
            // 查找URL模式
            const urlMatch = line.match(/https?:\/\/[^\s]+/g);
            if (urlMatch) {
                results.urls.push(...urlMatch);
            }

            // 查找文件操作
            if (line.includes('file://') || line.includes('FileSystemObject')) {
                results.fileOperations.push({
                    type: 'file',
                    details: line.trim()
                });
                results.suspiciousPatterns.push('文件系统访问');
            }

            // 查找网络请求
            if (line.includes('XMLHttpRequest') || line.includes('fetch(') || line.includes('http://')) {
                results.networkActivity.push({
                    type: 'network',
                    details: line.trim()
                });
            }

            // 查找可疑模式
            const suspiciousPatterns = [
                'eval(',
                'document.write',
                'innerHTML',
                'createElement',
                'setTimeout(',
                'setInterval(',
                'ActiveXObject',
                'WScript.Shell'
            ];

            for (const pattern of suspiciousPatterns) {
                if (line.includes(pattern)) {
                    const patternIndex = results.suspiciousPatterns.indexOf(pattern);
                    if (patternIndex === -1) {
                        results.suspiciousPatterns.push(pattern);
                    }
                }
            }
        }

        // 评估风险等级
        results.riskLevel = this.assessRiskLevel(results);

        return results;
    }

    /**
     * 评估风险等级
     * @param {object} results - 分析结果
     */
    assessRiskLevel(results) {
        let riskScore = 0;

        // 根据危险指标评分
        if (results.urls.length > 5) riskScore += 2;
        else if (results.urls.length > 0) riskScore += 1;

        if (results.fileOperations.length > 3) riskScore += 3;
        else if (results.fileOperations.length > 0) riskScore += 1;

        if (results.networkActivity.length > 3) riskScore += 2;
        else if (results.networkActivity.length > 0) riskScore += 1;

        if (results.maliciousBehavior.length > 0) riskScore += 5;

        if (results.suspiciousPatterns.length > 5) riskScore += 2;
        else if (results.suspiciousPatterns.length > 0) riskScore += 1;

        // 确定风险等级
        if (riskScore >= 8) return 'high';
        if (riskScore >= 4) return 'medium';
        if (riskScore >= 1) return 'low';
        return 'safe';
    }

    /**
     * 分析URL（通过沙盒环境）
     * @param {string} url - 要分析的URL
     */
    async analyzeURL(url) {
        try {
            console.log(`[沙盒] 分析URL: ${url}`);

            // 创建一个简单的HTML文件来测试URL
            const testHtml = `
                <html>
                <script>
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', '${url}', false);
                    try {
                        xhr.send();
                    } catch(e) {
                        console.log('URL test completed');
                    }
                </script>
                </html>
            `;

            // 临时文件路径
            const tempDir = path.join(process.env.UPLOAD_DIR || './uploads', 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const tempFile = path.join(tempDir, `url-test-${Date.now()}.html`);
            fs.writeFileSync(tempFile, testHtml);

            // 在沙盒中分析
            const result = await this.analyzeFile(tempFile, 'html');

            // 清理临时文件
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                console.error('[沙盒] 清理临时文件失败:', e);
            }

            return {
                url: url,
                ...result
            };

        } catch (error) {
            console.error('[沙盒] URL分析失败:', error);
            return {
                url: url,
                success: false,
                error: error.message,
                analysis: {
                    urls: [url],
                    riskLevel: 'unknown'
                }
            };
        }
    }

    /**
     * 获取沙盒状态
     */
    async getStatus() {
        try {
            if (!fs.existsSync(this.malwareJailPath)) {
                return {
                    installed: false,
                    message: 'MalwareJail未安装'
                };
            }

            const jailmePath = path.join(this.malwareJailPath, 'jailme.js');
            if (!fs.existsSync(jailmePath)) {
                return {
                    installed: true,
                    ready: false,
                    message: 'jailme.js未找到'
                };
            }

            return {
                installed: true,
                ready: true,
                path: this.malwareJailPath,
                message: '沙盒就绪'
            };

        } catch (error) {
            return {
                installed: false,
                ready: false,
                error: error.message
            };
        }
    }
}

module.exports = new SandboxService();
