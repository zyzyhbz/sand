/**
 * PDF/图片文本提取服务 (pdfExtractorService.js)
 *
 * 封装Python PDF提取模块的Node.js调用接口，提供：
 * - 从文件路径提取PDF文本
 * - 从文件路径提取图片OCR文本（PNG/JPEG等）
 * - 从base64编码数据提取PDF/图片文本
 * - 错误处理和降级机制
 * - 日志记录
 *
 * 使用示例:
 *   const pdfExtractor = require('./services/pdfExtractorService');
 *
 *   // 从PDF文件提取
 *   const result = await pdfExtractor.extractFromFile('/path/to/file.pdf');
 *
 *   // 从图片文件提取OCR文本
 *   const result = await pdfExtractor.extractFromImageFile('/path/to/image.png');
 *
 *   // 从base64提取
 *   const result = await pdfExtractor.extractFromBase64(base64Data);
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

// Python CLI脚本路径
const CLI_SCRIPT_PATH = path.join(__dirname, '..', 'pdf_extractor', 'cli.py');

// 默认配置
const DEFAULT_CONFIG = {
    maxPages: 50,
    useOcr: false,
    ocrLanguages: ['eng'],
    timeout: 300000, // 300秒超时(EasyOCR首次加载模型需要较长时间)
    maxBuffer: 50 * 1024 * 1024 // 50MB buffer(图片OCR可能产生较多输出)
};

// 支持的图片文件扩展名
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.gif', '.webp']);

/**
 * 判断文件是否为图片类型
 * @param {string} filePath - 文件路径
 * @returns {boolean} 是否为图片文件
 */
function _isImageFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
}

/**
 * PDF提取器类
 */
class PDFExtractorService {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.pythonCommand = this._detectPythonCommand();

        console.log('[PDF提取服务] 初始化完成');
        console.log(`[PDF提取服务] Python命令: ${this.pythonCommand}`);
        console.log(`[PDF提取服务] CLI路径: ${CLI_SCRIPT_PATH}`);
    }

    /**
     * 检测可用的Python命令
     * @returns {string} Python命令
     */
    _detectPythonCommand() {
        // 在Windows上，优先尝试python，然后尝试python3
        if (process.platform === 'win32') {
            return 'python';
        }
        // 在Unix系统上，优先尝试python3
        return 'python3';
    }

    /**
     * 执行Python CLI并返回结果
     * @param {string[]} args - 命令行参数
     * @returns {Promise<Object>} 解析后的JSON结果
     */
    async _executePython(args) {
        const command = `${this.pythonCommand} "${CLI_SCRIPT_PATH}" ${args.join(' ')}`;

        console.log(`[PDF提取服务] 执行命令: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                encoding: 'utf-8',
                timeout: this.config.timeout,
                maxBuffer: this.config.maxBuffer
            });

            // 记录stderr输出（Python日志）
            if (stderr) {
                console.log(`[PDF提取服务] Python stderr: ${stderr}`);
            }

            // 解析JSON输出
            const result = JSON.parse(stdout.trim());

            console.log(`[PDF提取服务] 提取完成, 状态: ${result.status || (result.success ? 'success' : 'error')}`);

            return result;

        } catch (error) {
            console.error(`[PDF提取服务] Python执行失败:`, error.message);

            // 返回错误结果
            return {
                success: false,
                error: error.message,
                data: null,
                compatibility: {
                    ai_ready: false,
                    format: '1.0',
                    truncated: false
                }
            };
        }
    }

    /**
     * 从文件路径提取PDF或图片文本（自动检测文件类型）
     * @param {string} filePath - PDF或图片文件路径
     * @param {Object} options - 提取选项
     * @returns {Promise<Object>} 提取结果
     */
    async extractFromFile(filePath, options = {}) {
        console.log(`[PDF提取服务] 从文件提取: ${filePath}`);

        // 验证文件是否存在
        if (!fs.existsSync(filePath)) {
            console.error(`[PDF提取服务] 文件不存在: ${filePath}`);
            return {
                success: false,
                error: `文件不存在: ${filePath}`,
                data: null,
                compatibility: { ai_ready: false, format: '1.0', truncated: false }
            };
        }

        // 自动检测：如果是图片文件，走图片OCR提取路径
        if (_isImageFile(filePath)) {
            console.log(`[PDF提取服务] 检测到图片文件，使用OCR提取: ${filePath}`);
            return await this.extractFromImageFile(filePath, options);
        }

        // 构建命令行参数（PDF文件）
        const args = [
            '--file', `"${filePath}"`,
            '--max-pages', options.maxPages || this.config.maxPages
        ];

        // 添加OCR选项
        if (options.useOcr || this.config.useOcr) {
            args.push('--use-ocr');
            const languages = options.ocrLanguages || this.config.ocrLanguages;
            if (languages && languages.length > 0) {
                args.push('--ocr-languages', ...languages);
            }
        }

        return await this._executePython(args);
    }

    /**
     * 从图片文件路径提取OCR文本
     * 使用Python CLI的 --image 参数进行OCR识别
     * @param {string} filePath - 图片文件路径（PNG/JPEG等）
     * @param {Object} options - 提取选项
     * @returns {Promise<Object>} 提取结果（格式与PDF提取一致）
     */
    async extractFromImageFile(filePath, options = {}) {
        console.log(`[PDF提取服务] 从图片文件提取OCR文本: ${filePath}`);

        // 验证文件是否存在
        if (!fs.existsSync(filePath)) {
            console.error(`[PDF提取服务] 图片文件不存在: ${filePath}`);
            return {
                success: false,
                error: `图片文件不存在: ${filePath}`,
                data: null,
                compatibility: { ai_ready: false, format: '1.0', truncated: false }
            };
        }

        // 构建命令行参数（使用 --image 强制OCR模式）
        const args = [
            '--image', `"${filePath}"`
        ];

        // 添加OCR语言选项
        const languages = options.ocrLanguages || this.config.ocrLanguages;
        if (languages && languages.length > 0) {
            args.push('--ocr-languages', ...languages);
        }

        return await this._executePython(args);
    }

    /**
     * 从base64编码数据提取PDF文本
     * @param {string} base64Data - base64编码的PDF数据
     * @param {Object} options - 提取选项
     * @returns {Promise<Object>} 提取结果
     */
    async extractFromBase64(base64Data, options = {}) {
        console.log(`[PDF提取服务] 从base64数据提取, 数据长度: ${base64Data.length}`);

        // 构建命令行参数
        const args = [
            '--base64',
            '--max-pages', options.maxPages || this.config.maxPages
        ];

        // 添加OCR选项
        if (options.useOcr || this.config.useOcr) {
            args.push('--use-ocr');
            const languages = options.ocrLanguages || this.config.ocrLanguages;
            if (languages && languages.length > 0) {
                args.push('--ocr-languages', ...languages);
            }
        }

        // 使用stdin传递base64数据
        return await this._executeWithStdin(args, base64Data);
    }

    /**
     * 使用stdin传递数据执行Python
     * @param {string[]} args - 命令行参数
     * @param {string} stdinData - stdin数据
     * @returns {Promise<Object>} 解析后的JSON结果
     */
    async _executeWithStdin(args, stdinData) {
        const { spawn } = require('child_process');

        return new Promise((resolve, reject) => {
            const pythonProcess = spawn(this.pythonCommand, [CLI_SCRIPT_PATH, ...args], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
                console.log(`[PDF提取服务] Python stderr: ${data.toString()}`);
            });

            pythonProcess.on('close', (code) => {
                try {
                    if (stdout.trim()) {
                        const result = JSON.parse(stdout.trim());
                        resolve(result);
                    } else {
                        resolve({
                            success: false,
                            error: 'Python没有返回任何输出',
                            data: null,
                            compatibility: { ai_ready: false, format: '1.0', truncated: false }
                        });
                    }
                } catch (parseError) {
                    console.error(`[PDF提取服务] JSON解析失败:`, parseError.message);
                    resolve({
                        success: false,
                        error: `JSON解析失败: ${parseError.message}`,
                        data: null,
                        compatibility: { ai_ready: false, format: '1.0', truncated: false }
                    });
                }
            });

            pythonProcess.on('error', (error) => {
                console.error(`[PDF提取服务] Python进程错误:`, error.message);
                resolve({
                    success: false,
                    error: `Python进程错误: ${error.message}`,
                    data: null,
                    compatibility: { ai_ready: false, format: '1.0', truncated: false }
                });
            });

            // 写入stdin数据
            pythonProcess.stdin.write(stdinData);
            pythonProcess.stdin.end();
        });
    }

    /**
     * 检查PDF提取依赖
     * @returns {Promise<Object>} 依赖检查结果
     */
    async checkDependencies() {
        console.log(`[PDF提取服务] 检查依赖...`);

        const args = ['--check-deps'];
        return await this._executePython(args);
    }

    /**
     * 提取文本内容（统一接口）
     * 根据输入类型自动选择提取方式（PDF/图片）
     * @param {string|Buffer} input - PDF/图片文件路径或base64数据
     * @param {Object} options - 提取选项
     * @returns {Promise<Object>} 提取结果
     */
    async extract(input, options = {}) {
        // 如果是Buffer，转换为base64
        if (Buffer.isBuffer(input)) {
            console.log(`[PDF提取服务] 输入是Buffer, 转换为base64`);
            return await this.extractFromBase64(input.toString('base64'), options);
        }

        // 如果是文件路径
        if (typeof input === 'string') {
            // 检查是否是文件路径
            if (fs.existsSync(input)) {
                return await this.extractFromFile(input, options);
            }

            // 假设是base64数据
            return await this.extractFromBase64(input, options);
        }

        // 不支持的输入类型
        return {
            success: false,
            error: '不支持的输入类型，请提供文件路径或base64数据',
            data: null,
            compatibility: { ai_ready: false, format: '1.0', truncated: false }
        };
    }

    /**
     * 获取提取的文本内容（简化接口）
     * @param {string|Buffer} input - PDF输入
     * @param {Object} options - 提取选项
     * @returns {Promise<string>} 提取的文本内容
     */
    async extractText(input, options = {}) {
        const result = await this.extract(input, options);

        if (result.success && result.data) {
            return result.data.extracted_text || '';
        }

        return '';
    }

    /**
     * 构建AI分析用的PDF内容对象
     * @param {Object} extractResult - 提取结果
     * @param {string} filename - 文件名
     * @returns {Object} AI分析用的内容对象
     */
    buildAIContent(extractResult, filename = 'unknown.pdf') {
        if (!extractResult.success) {
            return {
                success: false,
                filename: filename,
                error: extractResult.error || 'PDF提取失败',
                extractedText: '',
                aiReady: false
            };
        }

        const data = extractResult.data || {};

        return {
            success: true,
            filename: filename,
            extractedText: data.extracted_text || '',
            summary: data.summary || '',
            statistics: data.statistics || {},
            qualityIndicators: data.quality_indicators || {},
            aiReady: extractResult.compatibility?.ai_ready || false,
            method: extractResult.method || 'unknown',
            truncated: extractResult.compatibility?.truncated || false
        };
    }
}

// 导出单例实例
const pdfExtractorService = new PDFExtractorService();

module.exports = pdfExtractorService;

// 同时导出类，允许创建自定义实例
module.exports.PDFExtractorService = PDFExtractorService;
