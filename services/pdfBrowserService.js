/**
 * 基于浏览器的PDF生成服务
 * 使用Edge浏览器将HTML直接渲染为PDF，完美保留CSS样式
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

// Edge浏览器路径
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/**
 * 将HTML内容转换为PDF
 * 使用Edge浏览器渲染，确保CSS样式完美保留
 * @param {string} htmlContent - HTML内容
 * @param {Object} options - 配置选项
 * @returns {Promise<Buffer>} - PDF文件的Buffer
 */
async function convertHtmlToPdf(htmlContent, options = {}) {
    const {
        title = '安全分析报告',
        format = 'A4',
        margin = { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }
    } = options;

    console.log('[PDF浏览器服务] 开始生成PDF，使用Edge浏览器');

    let browser = null;
    try {
        // 启动Edge浏览器
        browser = await puppeteer.launch({
            executablePath: EDGE_PATH,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote'
            ]
        });

        // 创建新页面
        const page = await browser.newPage();

        // 设置HTML内容
        await page.setContent(htmlContent, {
            waitUntil: 'networkidle0'
        });

        console.log('[PDF浏览器服务] HTML内容已加载');

        // 生成PDF
        const pdfBuffer = await page.pdf({
            format: format,
            printBackground: true,
            margin: margin,
            displayHeaderFooter: true,
            headerTemplate: `
                <div style="font-size: 10px; padding: 10mm; width: 100%; text-align: center; color: #666;">
                    ${title}
                </div>
            `,
            footerTemplate: `
                <div style="font-size: 10px; padding: 10mm; width: 100%; text-align: right; color: #666;">
                    <span class="pageNumber"></span> / <span class="totalPages"></span>
                </div>
            `,
            scale: 1
        });

        console.log(`[PDF浏览器服务] PDF生成成功，大小: ${pdfBuffer.length} bytes`);

        return pdfBuffer;
    } catch (error) {
        console.error('[PDF浏览器服务] PDF生成失败:', error);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
            console.log('[PDF浏览器服务] 浏览器已关闭');
        }
    }
}

/**
 * 从完整的HTML页面生成PDF（包含样式）
 * @param {string} htmlContent - 完整的HTML内容（包含<head>和<style>）
 * @param {Object} options - 配置选项
 * @returns {Promise<Buffer>} - PDF文件的Buffer
 */
async function convertFullHtmlToPdf(htmlContent, options = {}) {
    const {
        title = '安全分析报告',
        format = 'A4',
        scale = 1,
        margin = { top: '10mm', right: '10mm', bottom: '15mm', left: '10mm' }
    } = options;

    console.log('[PDF浏览器服务] 开始从完整HTML生成PDF');

    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath: EDGE_PATH,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--enable-features=NetworkService',
                '--enable-network-information'
            ]
        });

        const page = await browser.newPage();

        // 设置视口大小为A4
        await page.setViewport({
            width: 794,  // A4 width in pixels at 96 DPI
            height: 1123, // A4 height in pixels at 96 DPI
            deviceScaleFactor: 2
        });
        // 强制打印媒体类型
        await page.emulateMediaType('print');

        // 设置HTML内容
        await page.setContent(htmlContent, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // 等待一段时间确保样式加载完成
        await new Promise(resolve => setTimeout(resolve, 500));

        // 强制注入CSS以确保PDF背景色渲染 - 使用最高优先级
        await page.evaluate(() => {
            // 收集页面中所有带背景样式的元素
            const allElements = document.querySelectorAll('*');
            allElements.forEach(el => {
                const style = el.getAttribute('style') || '';
                if (style.includes('background') || style.includes('bgcolor')) {
                    // 强制添加 print-color-adjust
                    el.style.setProperty('-webkit-print-color-adjust', 'exact', 'important');
                    el.style.setProperty('print-color-adjust', 'exact', 'important');
                }
            });

            // 创建或更新style标签 - 使用最高优先级
            let styleEl = document.getElementById('pdf-print-styles');
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = 'pdf-print-styles';
                // 使用最高优先级插入
                if (document.head.firstChild) {
                    document.head.insertBefore(styleEl, document.head.firstChild);
                } else {
                    document.head.appendChild(styleEl);
                }
            }

            // 注入强制背景色CSS - 最高优先级
            styleEl.textContent = `
                /* 最高优先级 - 强制PDF背景色渲染 */
                html, body, div, section, article, main, header, footer {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
                
                /* 保护关键容器 */
                .report-wrapper, .report-header, .report-content, .report-body {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
                
                /* 所有带background属性的元素 */
                [style*="background"] {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
                
                /* 信息卡片保护 */
                .info-card, .warning-card, .threat-card, .tip-card, .alert-card,
                .card, .analysis-card, .risk-card, .detail-card, .highlight-box, .callout {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
            `;
        });

        console.log('[PDF浏览器服务] HTML内容和样式已加载，强制背景色CSS已注入');

        // 生成PDF - 确保背景色正确渲染
        const pdfBuffer = await page.pdf({
            format: format,
            printBackground: true,
            scale: scale,
            margin: margin,
            preferCSSPageSize: false
        });

        console.log(`[PDF浏览器服务] PDF生成成功，大小: ${pdfBuffer.length} bytes`);

        return pdfBuffer;
    } catch (error) {
        console.error('[PDF浏览器服务] PDF生成失败:', error);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

module.exports = {
    convertHtmlToPdf,
    convertFullHtmlToPdf
};