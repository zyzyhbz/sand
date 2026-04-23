const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const quickmuService = require('./quickmu');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Decompiler服务
 * 提供可执行文件反编译和静态分析功能
 * 
 * 功能:
 * 1. .exe/.dll/.scr等Windows可执行文件的静态分析
 * 2. EML附件中可执行文件的提取和分析
 * 3. 返回标准格式: {success: true, result: {content: string, type: string}}
 */
class Decompiler {
    constructor() {
        // 支持的可执行文件扩展名
        this.supportedExtensions = [
            '.exe', '.dll', '.scr', '.com', '.msi', '.bin',
            '.sys', '.drv', '.ocx', '.cpl', '.ax',
            '.bat', '.cmd', '.ps1', '.vbs', '.js',
            '.py', '.pyc', '.pyo',
            '.jar', '.class',
            '.apk', '.dex', '.so'
        ];

        // EML MIME类型(用于识别附件中的可执行文件)
        this.executableMimeTypes = [
            'application/x-msdownload',
            'application/x-msdos-program',
            'application/x-executable',
            'application/octet-stream',
            'application/x-shockwave-flash',
            'application/x-dosexec'
        ];
    }

    /**
     * 判断文件是否为可执行文件
     * @param {string} filePath - 文件路径
     * @param {string} extension - 文件扩展名(可选)
     * @returns {boolean}
     */
    isExecutable(filePath, extension = null) {
        if (!extension) {
            extension = path.extname(filePath).toLowerCase();
        }
        return this.supportedExtensions.includes(extension);
    }

    /**
     * 反编译/分析文件
     * @param {string} filePath - 文件路径
     * @param {object} options - 选项 {deepAnalysis: boolean}
     * @returns {Promise<object>} {success: boolean, result: {content, type}, error?: string}
     */
    async decompile(filePath, options = {}) {
        const startTime = Date.now();
        const ext = path.extname(filePath).toLowerCase();

        try {
            if (!fs.existsSync(filePath)) {
                return {
                    success: false,
                    error: `文件不存在: ${filePath}`
                };
            }

            // 根据文件类型选择分析方法
            let analysisResult;

            if (['.jar', '.class'].includes(ext)) {
                analysisResult = await this._analyzeJavaFile(filePath, options);
            } else if (['.py', '.pyc', '.pyo'].includes(ext)) {
                analysisResult = await this._analyzePythonFile(filePath, options);
            } else if (['.apk', '.dex'].includes(ext)) {
                analysisResult = await this._analyzeAndroidFile(filePath, options);
            } else if (['.js', '.bat', '.cmd', '.ps1', '.vbs'].includes(ext)) {
                analysisResult = await this._analyzeScriptFile(filePath, options);
            } else {
                // 二进制可执行文件: 使用Quickmu进行静态分析
                analysisResult = await this._analyzeBinaryFile(filePath, options);
            }

            const duration = Date.now() - startTime;
            console.log(`[Decompiler] 文件分析完成: ${path.basename(filePath)} (${duration}ms)`);

            return {
                success: true,
                result: {
                    content: analysisResult.content,
                    type: analysisResult.type,
                    analysisTime: duration
                }
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`[Decompiler] 文件分析失败: ${path.basename(filePath)}`, error.message);

            // 返回格式化的错误响应
            return {
                success: false,
                error: `反编译失败: ${error.message}`,
                errorCode: 'DECOMPILE_ERROR'
            };
        }
    }

    /**
     * 分析二进制可执行文件(使用Quickmu)
     * @private
     */
    async _analyzeBinaryFile(filePath, options) {
        try {
            // 使用Quickmu进行静态分析
            const result = await quickmuService.getDetailedAnalysis(filePath);

            // 格式化输出
            let content = '=== 可执行文件静态分析报告 ===\n\n';

            if (result.info) {
                content += '【基本信息】\n';
                content += `- 文件名: ${path.basename(filePath)}\n`;
                content += `- 文件大小: ${result.info.fileSize || '未知'}\n`;
                content += `- MD5哈希: ${result.info.md5 || '未知'}\n`;
                content += `- SHA256哈希: ${result.info.sha256 || '未知'}\n`;
                content += `- 文件类型: ${result.info.fileType || '未知'}\n`;
                content += '\n';
            }

            if (result.staticAnalysis) {
                content += '【静态分析】\n';

                if (result.staticAnalysis.sections) {
                    content += '- PE段信息:\n';
                    result.staticAnalysis.sections.forEach(section => {
                        content += `  * ${section.name}: VirtualSize=${section.virtualSize}, RawSize=${section.rawSize}\n`;
                    });
                    content += '\n';
                }

                if (result.staticAnalysis.imports) {
                    content += '- 导入函数:\n';
                    result.staticAnalysis.imports.slice(0, 20).forEach(imp => {
                        content += `  * ${imp.dll}::${imp.function}\n`;
                    });
                    if (result.staticAnalysis.imports.length > 20) {
                        content += `  ... 还有 ${result.staticAnalysis.imports.length - 20} 个导入函数\n`;
                    }
                    content += '\n';
                }

                if (result.staticAnalysis.exports) {
                    content += '- 导出函数:\n';
                    result.staticAnalysis.exports.slice(0, 10).forEach(exp => {
                        content += `  * ${exp}\n`;
                    });
                    content += '\n';
                }

                if (result.staticAnalysis.entropy) {
                    content += `- 文件熵值: ${result.staticAnalysis.entropy} (${result.staticAnalysis.entropy > 7 ? '高熵值(可能已加密或加壳)' : '正常'})\n`;
                    content += '\n';
                }
            }

            if (result.threatIndicators) {
                content += '【威胁指标】\n';
                result.threatIndicators.forEach(indicator => {
                    content += `- [${indicator.severity}] ${indicator.description}\n`;
                    if (indicator.details) {
                        content += `  详情: ${indicator.details}\n`;
                    }
                });
                content += '\n';
            }

            if (result.behaviorAnalysis) {
                content += '【行为分析】\n';

                if (result.behaviorAnalysis.fileActivity) {
                    content += '- 文件操作:\n';
                    result.behaviorAnalysis.fileActivity.slice(0, 10).forEach(op => {
                        content += `  * ${op.action}: ${op.target}\n`;
                    });
                    content += '\n';
                }

                if (result.behaviorAnalysis.registryActivity) {
                    content += '- 注册表操作:\n';
                    result.behaviorAnalysis.registryActivity.slice(0, 10).forEach(op => {
                        content += `  * ${op.action}: ${op.target}\n`;
                    });
                    content += '\n';
                }

                if (result.behaviorAnalysis.networkActivity) {
                    content += '- 网络活动:\n';
                    result.behaviorAnalysis.networkActivity.forEach(net => {
                        content += `  * ${net.type}: ${net.target}\n`;
                    });
                    content += '\n';
                }
            }

            if (result.strings) {
                content += '【提取的字符串】\n';
                const suspiciousStrings = result.strings.filter(s =>
                    s.includes('http') || s.includes('ftp') ||
                    s.includes('.dll') || s.includes('regsvr32') ||
                    s.includes('cmd.exe') || s.includes('powershell')
                ).slice(0, 20);

                if (suspiciousStrings.length > 0) {
                    suspiciousStrings.forEach(str => {
                        content += `  ${str}\n`;
                    });
                    content += '\n';
                }
            }

            return {
                content: content,
                type: 'binary_analysis'
            };

        } catch (error) {
            // Quickmu分析失败,返回基础信息
            return this._getBasicBinaryInfo(filePath);
        }
    }

    /**
     * 获取二进制文件的基础信息(当完整分析失败时)
     * @private
     */
    async _getBasicBinaryInfo(filePath) {
        const stats = fs.statSync(filePath);
        const binaryContent = fs.readFileSync(filePath);

        // 读取文件头(前1000字节)
        const headerHex = binaryContent.toString('hex').substring(0, 2000);

        // 检测PE文件头
        const isPE = headerHex.substring(0, 8) === '4d5a900003000000'; // MZ签名

        let content = '=== 可执行文件基础信息 ===\n\n';
        content += `【基本信息】\n`;
        content += `- 文件名: ${path.basename(filePath)}\n`;
        content += `- 文件大小: ${stats.size} bytes\n`;
        content += `- PE文件: ${isPE ? '是' : '否'}\n`;
        content += '\n';
        content += `【文件头部(HEX)】\n`;
        content += headerHex + '\n';
        content += '\n(警告: 完整分析失败,仅显示基础信息)\n';

        return {
            content: content,
            type: 'binary_basic_info'
        };
    }

    /**
     * 分析脚本文件
     * @private
     */
    async _analyzeScriptFile(filePath, options) {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const ext = path.extname(filePath).toLowerCase();

        let content = `=== ${ext} 脚本文件分析 ===\n\n`;
        content += `文件名: ${path.basename(filePath)}\n`;
        content += `文件大小: ${fs.statSync(filePath).size} bytes\n`;
        content += '\n';

        // 分析脚本内容
        if (ext === '.js' || ext === '.vbs') {
            // JavaScript/VBScript分析
            content += '【代码统计】\n';
            content += `- 总行数: ${fileContent.split('\n').length}\n`;
            content += `- 代码行数: ${fileContent.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length}\n`;
            content += '\n';

            // 检测可疑特征
            const suspiciousPatterns = [
                { pattern: /eval\s*\(.+\)/gi, name: 'eval动态执行' },
                { pattern: /ActiveXObject|WScript\.Shell/gi, name: 'COM对象调用' },
                { pattern: /exec\s*\(/gi, name: '命令执行' },
                { pattern: /document\.write/gi, name: 'DOM写入' },
                { pattern: /onerror|onload|onclick/gi, name: '事件处理器' }
            ];

            const foundPatterns = [];
            suspiciousPatterns.forEach(({ pattern, name }) => {
                const matches = fileContent.match(pattern);
                if (matches) {
                    foundPatterns.push(`${name}: ${matches.length}处`);
                }
            });

            if (foundPatterns.length > 0) {
                content += '【可疑特征】\n';
                foundPatterns.forEach(p => content += `- ${p}\n`);
                content += '\n';
            }
        } else if (ext === '.bat' || ext === '.cmd') {
            // Batch脚本分析
            const suspiciousPatterns = [
                { pattern: /powershell|curl|wget/i, name: '下载工具调用' },
                { pattern: /reg\s+add|reg\s+delete/i, name: '注册表修改' },
                { pattern: /net\s+user|net\s+localgroup/i, name: '用户管理命令' },
                { pattern: /taskkill|tasklist/i, name: '进程管理' }
            ];

            const foundPatterns = [];
            suspiciousPatterns.forEach(({ pattern, name }) => {
                const matches = fileContent.match(pattern);
                if (matches) {
                    foundPatterns.push(`${name}: ${matches.length}处`);
                }
            });

            if (foundPatterns.length > 0) {
                content += '【可疑特征】\n';
                foundPatterns.forEach(p => content += `- ${p}\n`);
                content += '\n';
            }
        } else if (ext === '.ps1') {
            // PowerShell脚本分析
            const suspiciousPatterns = [
                { pattern: /Invoke-Expression|iex/i, name: '动态代码执行' },
                { pattern: /DownloadString|WebRequest/i, name: '网络下载' },
                { pattern: /Add-Type/gi, name: '类型注入' },
                { pattern: /Set-ExecutionPolicy/i, name: '执行策略修改' }
            ];

            const foundPatterns = [];
            suspiciousPatterns.forEach(({ pattern, name }) => {
                const matches = fileContent.match(pattern);
                if (matches) {
                    foundPatterns.push(`${name}: ${matches.length}处`);
                }
            });

            if (foundPatterns.length > 0) {
                content += '【可疑特征】\n';
                foundPatterns.forEach(p => content += `- ${p}\n`);
                content += '\n';
            }
        }

        // 显示文件内容(如果不是太大)
        const maxContentLength = 10000;
        if (fileContent.length <= maxContentLength) {
            content += '【完整代码】\n';
            content += '```\n';
            content += fileContent;
            content += '\n```\n';
        } else {
            content += '【代码片段(前5000字符)】\n';
            content += '```\n';
            content += fileContent.substring(0, 5000);
            content += '\n...\n(代码过长,仅显示前5000字符)\n```\n';
        }

        return {
            content: content,
            type: 'script_analysis'
        };
    }

    /**
     * 分析Java文件
     * @private
     */
    async _analyzeJavaFile(filePath, options) {
        const stats = fs.statSync(filePath);

        let content = '=== Java字节码文件分析 ===\n\n';
        content += `文件名: ${path.basename(filePath)}\n`;
        content += `文件大小: ${stats.size} bytes\n`;
        content += '\n';

        // 尝试使用javap反编译
        try {
            const { stdout } = await execAsync(`javap -c -p -v "${filePath}"`, {
                encoding: 'utf-8',
                timeout: 5000,
                maxBuffer: 1024 * 1024 * 10
            });

            content += '【反编译结果】\n';
            content += '```\n';
            content += stdout;
            content += '\n```\n';
        } catch (error) {
            content += '【警告】javap反编译失败\n';
            content += `错误: ${error.message}\n`;
            content += '\n提示: 请确保已安装JDK并配置javap命令\n';
        }

        return {
            content: content,
            type: 'java_analysis'
        };
    }

    /**
     * 分析Python文件
     * @private
     */
    async _analyzePythonFile(filePath, options) {
        const ext = path.extname(filePath).toLowerCase();

        let content = '=== Python文件分析 ===\n\n';
        content += `文件名: ${path.basename(filePath)}\n`;
        content += `文件类型: ${ext === '.py' ? 'Python源码' : 'Python字节码'}\n`;
        content += '\n';

        if (ext === '.py') {
            // Python源码文件
            const fileContent = fs.readFileSync(filePath, 'utf-8');

            content += '【代码统计】\n';
            content += `- 总行数: ${fileContent.split('\n').length}\n`;
            content += `- 代码行数: ${fileContent.split('\n').filter(l => l.trim() && !l.trim().startswith('#')).length}\n`;
            content += '\n';

            // 检测可疑导入
            const suspiciousImports = [
                'subprocess', 'os.system', 'eval', 'exec',
                'pickle', 'marshal', 'ctypes'
            ];

            const foundSuspicious = [];
            suspiciousImports.forEach(imp => {
                if (fileContent.includes(imp)) {
                    foundSuspicious.push(imp);
                }
            });

            if (foundSuspicious.length > 0) {
                content += '【可疑导入】\n';
                foundSuspicious.forEach(i => content += `- ${i}\n`);
                content += '\n';
            }

            // 显示代码
            const maxContentLength = 10000;
            if (fileContent.length <= maxContentLength) {
                content += '【完整代码】\n';
                content += '```python\n';
                content += fileContent;
                content += '\n```\n';
            } else {
                content += '【代码片段(前5000字符)】\n';
                content += '```python\n';
                content += fileContent.substring(0, 5000);
                content += '\n...\n(代码过长,仅显示前5000字符)\n```\n';
            }
        } else {
            // Python字节码文件
            content += '【注意】\n';
            content += '这是Python字节码文件(.pyc/.pyo),无法直接读取源代码。\n';
            content += '建议使用uncompyle6等工具进行反编译。\n';

            // 显示文件头
            const binaryContent = fs.readFileSync(filePath);
            const headerHex = binaryContent.toString('hex').substring(0, 32);
            content += '\n【文件头(HEX)】\n';
            content += headerHex + '\n';
        }

        return {
            content: content,
            type: 'python_analysis'
        };
    }

    /**
     * 分析Android文件
     * @private
     */
    async _analyzeAndroidFile(filePath, options) {
        const stats = fs.statSync(filePath);

        let content = '=== Android文件分析 ===\n\n';
        content += `文件名: ${path.basename(filePath)}\n`;
        content += `文件类型: ${path.extname(filePath)}\n`;
        content += `文件大小: ${stats.size} bytes\n`;
        content += '\n';
        content += '【注意】\n';
        content += '完整的APK/DEX分析需要专业的Android反编译工具(如jadx, apktool)。\n';
        content += '建议将这些文件发送到专业的恶意软件分析环境进行深入分析。\n';
        content += '\n【推荐的Android分析工具】\n';
        content += '- JADX: https://github.com/skylot/jadx\n';
        content += '- Apktool: https://ibotpeaches.github.io/Apktool/\n';
        content += '- Androguard: https://github.com/androguard/androguard\n';

        return {
            content: content,
            type: 'android_analysis'
        };
    }
}

module.exports = new Decompiler();
