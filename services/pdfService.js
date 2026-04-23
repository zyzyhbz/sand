/**
 * PDF转换服务
 * 将HTML报告内容转换为PDF格式
 * 增强版：支持页眉、页脚、自动分页、中文优化
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// 中文字体路径 - 使用Noto Sans SC
const CHINESE_FONT_PATH = path.join(__dirname, '..', 'node_modules', 'pdfkit', 'lib', 'font', 'notoSansCJK-Regular.ttc');
// 备用中文字体 - 使用系统字体
const SYSTEM_CHINESE_FONTS = [
    'C:\\Windows\\Fonts\\NotoSansSC-VF.ttf',
    'C:\\Windows\\Fonts\\simsun.ttc',
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\simhei.ttf'
];

// 全局状态
let chineseFontRegistered = false;
let chineseFontPath = null;
let currentPageNumber = 0;
let totalPages = 0;
let pdfTitle = '安全分析报告';

// 尝试获取可用的中文字体
function getAvailableChineseFont() {
    for (const fontPath of SYSTEM_CHINESE_FONTS) {
        if (fs.existsSync(fontPath)) {
            console.log(`[PDF字体] 使用中文字体: ${fontPath}`);
            return fontPath;
        }
    }
    console.warn('[PDF字体] 未找到中文字体，将使用Helvetica（可能无法显示中文）');
    return null;
}

// 检查并注册字体
function ensureChineseFont(doc) {
    if (chineseFontRegistered) return;

    chineseFontPath = getAvailableChineseFont();
    if (chineseFontPath) {
        try {
            doc.registerFont('NotoSansSC', chineseFontPath);
            doc.registerFont('NotoSansSC-Bold', chineseFontPath);
            chineseFontRegistered = true;
            console.log('[PDF字体] 中文字体注册成功');
        } catch (err) {
            console.error('[PDF字体] 中文字体注册失败:', err.message);
        }
    } else {
        console.warn('[PDF字体] 使用默认Helvetica字体');
    }
}

// 获取当前使用的字体名称
function getFontName() {
    return chineseFontRegistered ? 'NotoSansSC' : 'Helvetica';
}

function getBoldFontName() {
    return chineseFontRegistered ? 'NotoSansSC-Bold' : 'Helvetica-Bold';
}

// 绘制页眉
function drawHeader(doc, title) {
    const fontName = getFontName();
    const boldFontName = getBoldFontName();

    doc.fontSize(10)
        .font(boldFontName)
        .fillColor('#333333')
        .text(title || pdfTitle, 50, 30, {
            align: 'center',
            width: doc.page.width - 100
        });

    // 绘制页眉分隔线
    doc.strokeColor('#cccccc')
        .lineWidth(0.5)
        .moveTo(50, 45)
        .lineTo(doc.page.width - 50, 45)
        .stroke();

    doc.fillColor('#000000');
}

// 绘制页脚
function drawFooter(doc) {
    const fontName = getFontName();
    const generateTime = new Date().toLocaleString('zh-CN');

    // 绘制页脚分隔线
    doc.strokeColor('#cccccc')
        .lineWidth(0.5)
        .moveTo(50, doc.page.height - 50)
        .lineTo(doc.page.width - 50, doc.page.height - 50)
        .stroke();

    // 生成时间（左侧）
    doc.fontSize(8)
        .font(fontName)
        .fillColor('#666666')
        .text(`生成时间: ${generateTime}`, 50, doc.page.height - 40);

    // 页码（右侧）
    const pageText = `第 ${currentPageNumber} 页 / 共 ${totalPages} 页`;
    doc.text(pageText, doc.page.width - 150, doc.page.height - 40, {
        width: 100,
        align: 'right'
    });

    doc.fillColor('#000000');
}

// 页面添加到文档时触发
function onPageAdded(doc) {
    currentPageNumber++;
    console.log(`[PDF分页] 添加新页面，当前第 ${currentPageNumber} 页`);

    // 在新页面绘制页眉
    drawHeader(doc, pdfTitle);
}

/**
 * 将HTML报告转换为PDF
 * 增强版：支持页眉、页脚、自动分页
 * @param {Object} report - 报告数据对象
 * @param {string} htmlContent - HTML报告内容
 * @returns {Promise<Buffer>} - PDF文件的Buffer
 */
async function convertHtmlToPdf(report, htmlContent) {
    return new Promise((resolve, reject) => {
        try {
            // 重置分页计数器
            currentPageNumber = 0;
            totalPages = 0;
            chineseFontRegistered = false;
            pdfTitle = report.displayId || report.id || '沙箱安全分析报告';

            console.log('[PDF转换] 开始生成PDF，标题:', pdfTitle);

            // 创建PDF文档 - 调整边距以适应页眉页脚
            const doc = new PDFDocument({
                size: 'A4',
                margins: {
                    top: 60,      // 增加顶部边距给页眉
                    bottom: 60,   // 增加底部边距给页脚
                    left: 50,
                    right: 50
                },
                info: {
                    Title: pdfTitle,
                    Author: 'Sand Security Analysis System',
                    Subject: '邮件安全分析报告',
                    CreationDate: new Date()
                }
            });

            // 注册页面事件
            doc.on('pageAdded', () => onPageAdded(doc));

            // 收集PDF数据
            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => {
                totalPages = currentPageNumber;
                console.log(`[PDF转换] PDF生成完成，共 ${totalPages} 页`);
                const pdfBuffer = Buffer.concat(chunks);
                resolve(pdfBuffer);
            });
            doc.on('error', (err) => {
                console.error('[PDF转换] PDF生成错误:', err);
                reject(err);
            });

            // 解析HTML并生成PDF内容
            generatePdfContent(doc, report, htmlContent);

            // 结束文档后会触发end事件，此时currentPageNumber就是总页数
            doc.end();
        } catch (error) {
            console.error('[PDF转换] 生成PDF失败:', error);
            reject(error);
        }
    });
}

/**
 * 生成PDF内容
 * 增强版：添加页眉页脚、自动分页
 * @param {PDFDocument} doc - PDFKit文档对象
 * @param {Object} report - 报告数据
 * @param {string} htmlContent - HTML内容
 */
function generatePdfContent(doc, report, htmlContent) {
    // 确保中文字体已注册
    ensureChineseFont(doc);

    // 获取当前字体
    const fontName = getFontName();
    const boldFontName = getBoldFontName();

    // 绘制首页页眉
    drawHeader(doc, pdfTitle);

    // 首页绘制页脚
    drawFooter(doc);

    // 标题
    const title = report.displayId || report.id || '安全分析报告';
    doc.fontSize(20)
        .font(boldFontName)
        .text('沙箱安全分析报告', { align: 'center' });

    doc.moveDown(0.5);

    // 报告名称
    doc.fontSize(14)
        .font(fontName)
        .text(`文件名: ${title}`, { align: 'left' });

    // 分析时间
    const analyzeTime = report.summary?.analyzedAt
        ? new Date(report.summary.analyzedAt).toLocaleString('zh-CN')
        : new Date().toLocaleString('zh-CN');
    doc.text(`分析时间: ${analyzeTime}`);

    // 风险等级
    const riskLevel = report.summary?.riskLevel || 'unknown';
    const riskColor = getRiskLevelColor(riskLevel);
    doc.fillColor(riskColor)
        .text(`风险等级: ${getRiskLevelText(riskLevel)}`)
        .fillColor('#000000');

    doc.moveDown();
    doc.fontSize(12).font(boldFontName).text('─'.repeat(40));
    doc.moveDown();

    // 解析HTML内容，提取关键信息
    const parsedContent = parseHtmlContent(htmlContent);

    // 输出摘要信息
    if (report.summary) {
        doc.fontSize(14)
            .font(boldFontName)
            .text('分析摘要');

        doc.fontSize(10).font(fontName);

        if (report.summary.totalUrls !== undefined) {
            doc.text(`- 检测到URL数量: ${report.summary.totalUrls}`);
        }
        if (report.summary.totalFileOps !== undefined) {
            doc.text(`- 文件操作数量: ${report.summary.totalFileOps}`);
        }
        if (report.summary.totalNetworkAct !== undefined) {
            doc.text(`- 网络活动数量: ${report.summary.totalNetworkAct}`);
        }
        if (report.summary.suspiciousPatterns !== undefined) {
            doc.text(`- 可疑行为数量: ${report.summary.suspiciousPatterns}`);
        }

        doc.moveDown();
    }

    // 输出URL列表
    if (parsedContent.urls && parsedContent.urls.length > 0) {
        doc.fontSize(14)
            .font(boldFontName)
            .text('检测到的URL');

        doc.fontSize(9).font(fontName);

        parsedContent.urls.slice(0, 30).forEach((url, index) => {
            // 考虑页眉页脚，调整分页阈值
            if (doc.y > 680) {
                doc.addPage();
            }
            doc.text(`${index + 1}. ${url}`, { lineBreak: false });
        });
        doc.moveDown();
    }

    // 输出文件操作
    if (parsedContent.fileOps && parsedContent.fileOps.length > 0) {
        if (doc.y > 630) {
            doc.addPage();
        }

        doc.fontSize(14)
            .font(boldFontName)
            .text('文件操作记录');

        doc.fontSize(9).font(fontName);
        parsedContent.fileOps.slice(0, 20).forEach((op, index) => {
            if (doc.y > 680) {
                doc.addPage();
            }
            doc.text(`${index + 1}. ${op}`, { lineBreak: false });
        });

        if (parsedContent.fileOps.length > 20) {
            doc.text(`... 还有 ${parsedContent.fileOps.length - 20} 条记录`);
        }

        doc.moveDown();
    }

    // 输出网络活动
    if (parsedContent.networkAct && parsedContent.networkAct.length > 0) {
        if (doc.y > 630) {
            doc.addPage();
        }

        doc.fontSize(14)
            .font(boldFontName)
            .text('网络活动记录');

        doc.fontSize(9).font(fontName);

        parsedContent.networkActivity.slice(0, 20).forEach((activity, index) => {
            if (doc.y > 680) {
                doc.addPage();
            }
            doc.text(`${index + 1}. ${activity}`, { lineBreak: false });
        });

        doc.moveDown();
    }

    // 输出AI分析内容
    if (report.aiReport) {
        if (doc.y > 630) {
            doc.addPage();
        }

        doc.fontSize(14)
            .font(boldFontName)
            .text('AI智能分析');

        doc.fontSize(10).font(fontName);

        // 分页输出AI报告内容
        const aiLines = wrapText(report.aiReport, 80);
        aiLines.forEach(line => {
            if (doc.y > 700) {
                doc.addPage();
            }
            doc.text(line);
        });
    }

    // 注意：页脚现在在doc.on('end')中绘制，因为需要等待所有页面生成完毕
}

/**
 * 解析HTML内容，提取关键信息
 * @param {string} htmlContent - HTML内容
 * @returns {Object} - 解析后的内容对象
 */
function parseHtmlContent(htmlContent) {
    const result = {
        urls: [],
        fileOps: [],
        networkActivity: [],
        suspiciousPatterns: []
    };

    if (!htmlContent) {
        return result;
    }

    try {
        // 提取URL
        const urlMatches = htmlContent.match(/href=["'](http[^"']+)["']/gi) || [];
        result.urls = [...new Set(urlMatches.map(m => m.match(/href=["'](.*?)["']/)[1]))];

        // 提取文件路径
        const fileMatches = htmlContent.match(/[A-Za-z]:\\[^<>"\|?*]+|[/][^<>"\|?*]+/gi) || [];
        result.fileOps = [...new Set(fileMatches)].filter(f => f.length > 5 && f.length < 200);

        // 提取IP地址
        const ipMatches = htmlContent.match(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g) || [];
        result.networkActivity = [...new Set(ipMatches)];
    } catch (error) {
        console.error('[PDF转换] 解析HTML内容失败:', error);
    }

    return result;
}

/**
 * 文本自动换行
 * @param {string} text - 原始文本
 * @param {number} maxChars - 每行最大字符数
 * @returns {string[]} - 换行后的文本数组
 */
function wrapText(text, maxChars) {
    if (!text) return [];

    const lines = [];
    const paragraphs = text.split('\n');

    paragraphs.forEach(paragraph => {
        let currentLine = '';
        const words = paragraph.split(/(\s+)/);

        words.forEach(word => {
            if ((currentLine + word).length > maxChars) {
                if (currentLine.trim()) {
                    lines.push(currentLine.trim());
                }
                currentLine = word;
            } else {
                currentLine += word;
            }
        });

        if (currentLine.trim()) {
            lines.push(currentLine.trim());
        }
    });

    return lines;
}

/**
 * 获取风险等级对应的颜色
 * @param {string} level - 风险等级
 * @returns {string} - 颜色代码
 */
function getRiskLevelColor(level) {
    switch (level?.toLowerCase()) {
        case 'high':
        case 'high-risk':
        case '危险':
            return '#dc3545';
        case 'medium':
        case 'medium-risk':
        case '中危':
            return '#ffc107';
        case 'low':
        case 'low-risk':
        case '低危':
            return '#17a2b8';
        case 'safe':
        case 'safe-risk':
        case '安全':
            return '#28a745';
        default:
            return '#6c757d';
    }
}

/**
 * 获取风险等级的中文描述
 * @param {string} level - 风险等级
 * @returns {string} - 中文描述
 */
function getRiskLevelText(level) {
    switch (level?.toLowerCase()) {
        case 'high':
        case 'high-risk':
            return '高危';
        case 'medium':
        case 'medium-risk':
            return '中危';
        case 'low':
        case 'low-risk':
            return '低危';
        case 'safe':
        case 'safe-risk':
            return '安全';
        default:
            return '未知';
    }
}

/**
 * 保存PDF到临时文件
 * @param {Buffer} pdfBuffer - PDF数据
 * @param {string} filename - 文件名
 * @returns {string} - 保存的文件路径
 */
async function savePdfToFile(pdfBuffer, filename) {
    const tempDir = path.join(__dirname, '..', 'temp');

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const filePath = path.join(tempDir, `${filename}.pdf`);
    fs.writeFileSync(filePath, pdfBuffer);

    return filePath;
}

/**
 * 清理临时PDF文件
 * @param {string} filePath - 文件路径
 */
function cleanupPdfFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error('[PDF转换] 清理临时文件失败:', error);
    }
}

module.exports = {
    convertHtmlToPdf,
    savePdfToFile,
    cleanupPdfFile
};