const OpenAI = require('openai');

const API_KEY = 'sk-12109df04a8a4602b2a0a5f0536cb39f';
const API_BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-reasoner';

class AIReportService {
    constructor() {
        this.client = new OpenAI({
            apiKey: API_KEY,
            baseURL: API_BASE_URL
        });
        this.model = MODEL;
    }

    async generateDetailedReport(analysisData, fileInfo, urlData = null, toolUsed = 'Analysis Tool') {
        try {
            const prompt = this.buildReportPrompt(analysisData, fileInfo, urlData, toolUsed);

            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a senior cybersecurity expert and malware analyst. Your output must be complete HTML5 code without markdown markers, directly displayable in browsers. All content must be in Chinese.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.5,
                max_tokens: 6000
            });

            const htmlContent = response.choices[0].message.content;
            const cleanHtml = this.cleanHtmlContent(htmlContent);

            return {
                success: true,
                html: cleanHtml,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error('[AI Report] Failed to generate detailed report:', error);
            throw new Error('Report generation failed: ' + error.message);
        }
    }

    buildReportPrompt(analysisData, fileInfo, urlData, toolUsed) {
        let prompt = 'You are a senior cybersecurity expert and malware analyst with 15+ years of experience. Your analysis must be thorough, evidence-based, and professionally rigorous. Important: The entire report must use Chinese including all titles and content.';

        if (analysisData && analysisData.analysis) {
            const analysis = analysisData.analysis;
            if (analysis.fullContent) {
                prompt += '\n\n[文件完整内容]\n' + analysis.fullContent;
            }
            if (analysis.emailInfo) {
                prompt += '\n\n[邮件信息]\n发件人: ' + (analysis.emailInfo.from || 'Unknown') + '\n收件人: ' + (analysis.emailInfo.to || 'Unknown') + '\n主题: ' + (analysis.emailInfo.subject || 'Unknown');
            }
            if (analysis.structureInfo) {
                if (analysis.structureInfo.attachments && analysis.structureInfo.attachments.length > 0) {
                    prompt += '\n\n[附件列表]\n';
                    analysis.structureInfo.attachments.forEach((att, i) => {
                        prompt += `${i + 1}. ${att.filename || '未知文件名'} (${att.size || '未知大小'})\n`;
                    });
                }
                if (analysis.structureInfo.urlsFound && analysis.structureInfo.urlsFound.length > 0) {
                    prompt += '\n\n[发现的URL]\n';
                    analysis.structureInfo.urlsFound.forEach((url, i) => {
                        prompt += `${i + 1}. ${url}\n`;
                    });
                }
            }
        }

        // 添加详细的要求，确保分析严谨、全面、不过度敏感
        prompt += `

## 分析要求

请生成一份专业、详尽的安全分析报告，包含以下内容：

### 1. 执行摘要 (Executive Summary)
- 用2-3句话概括文件/邮件的整体评估
- 明确给出风险等级：安全(Safe)、低危(Low)、中危(Medium)、高危(High)、严重(Critical)

### 2. 详细分析 (Detailed Analysis) - 这是最重要的部分，需要充分展开
对于每个发现的可疑点，必须包含：
- **证据引用**：具体是哪段内容/哪个特征
- **分析推理**：为什么这被认为是可疑的，结合实际上下文
- **误报可能性**：是否存在正常用途的解释？是否可能是误报？
- **实际风险**：如果真的是恶意行为，可能造成的危害是什么

### 3. 威胁指标 (Threat Indicators)
逐项列出每个威胁指标，并解释：
- 这个指标是什么
- 它在当前文件中的具体表现
- 置信度评估（高/中/低）- 基于多少证据得出这个结论

### 4. 技术细节 (Technical Details)
- 提供具体的技术分析数据
- 包含HEX内容、编码方式、字符串分析等原始证据

### 5. 风险评估 (Risk Assessment)
**重要**：在给出风险等级时，必须遵循以下原则：
- 只有在有明确、充足证据表明存在恶意意图时，才能判定为高危或严重
- 如果只是"可疑"但缺乏直接证据，应判定为中危或低危
- 考虑上下文：钓鱼邮件与实际恶意软件应区别对待
- 区分"技术特征可疑"和"实际存在威胁"

### 6. 处置与防护建议 (Recommendations/Remediation)
**重要**：这一部分必须使用动态框格式！请为每个建议项使用相应的卡片样式。参考以下示例：

示例格式（高危/严重等级）：
<div class="danger-card">
  <div class="danger-card-title">🚨 高危 - 紧急处置建议</div>
  <ul class="styled-list">
    <li>立即隔离该文件，禁止在系统中运行</li>
    <li>通知安全团队进行深入调查</li>
    <li>检查是否有其他来自同一来源的文件</li>
  </ul>
</div>

示例格式（中危等级）：
<div class="warning-card">
  <div class="warning-card-title">⚠️ 中危 - 防护建议</div>
  <ul class="styled-list">
    <li>建议措施1：具体描述</li>
    <li>建议措施2：具体描述</li>
  </ul>
</div>

示例格式（低危/安全等级）：
<div class="success-card">
  <div class="success-card-title">✅ 安全 - 常规建议</div>
  <ul class="styled-list">
    <li>保持系统安全更新</li>
    <li>继续监控该文件来源</li>
  </ul>
</div>
## 评级标准参考
- 🔴 高危/严重：明确的恶意代码、钓鱼行为、 exploits、勒索软件特征
- 🟡 中危：可疑行为但需要进一步确认、可能的钓鱼意图
- 🟢 低危：技术特征异常但有合理解释、需要关注
- 🔵 安全：未发现明显威胁特征

**非常重要**：在你的分析报告的最后一行（所有HTML内容之后），必须添加一个HTML注释来标记你最终的风险评级结论。格式严格如下：
<!-- RISK_ASSESSMENT: high --> 或 <!-- RISK_ASSESSMENT: medium --> 或 <!-- RISK_ASSESSMENT: low --> 或 <!-- RISK_ASSESSMENT: safe --> 或 <!-- RISK_ASSESSMENT: critical -->
这个注释用于系统提取你的评级结论，不会显示在页面上。请根据你的分析结果选择最准确的评级。

## HTML格式要求
使用以下HTML结构：

1. 章节标题: <div class="section-title"><span class="section-icon">📋</span> 标题</div>
2. 信息卡片(用于提示信息): <div class="info-card"><div class="info-card-title">🔍 标题</div> 内容</div>
3. 警告卡片(用于警告内容): <div class="warning-card"><div class="warning-card-title">⚠️ 标题</div> 内容</div>
4. 危险卡片(用于高危内容): <div class="danger-card"><div class="danger-card-title">🚨 标题</div> 内容</div>
5. 安全卡片(用于安全内容): <div class="success-card"><div class="success-card-title">✅ 标题</div> 内容</div>
6. 数据表格: <table class="data-table"><thead>...</thead><tbody>...</tbody></table>
7. 列表: <ul class="styled-list"><li>内容</li></ul>
8. 彩色标签: <span class="tag tag-high">🔴 高危</span> / <span class="tag tag-medium">🟡 中危</span> / <span class="tag tag-low">🟢 低危</span> / <span class="tag tag-info">🔵 信息</span>
9. 重点强调框: <div class="highlight-box">内容</div>`;

        return prompt;
    }

    cleanHtmlContent(html) {
        if (!html) return '';
        let cleaned = html.trim();
        const backtick = String.fromCharCode(96);
        cleaned = cleaned.split(backtick + backtick + backtick + 'html').join('');
        cleaned = cleaned.split(backtick + backtick + backtick).join('');

        cleaned = cleaned
            .replace(/<!DOCTYPE[^>]*>/gi, '')
            .replace(/<html[^>]*>/gi, '')
            .replace(/<\/html>/gi, '')
            .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
            .replace(/<body[^>]*>/gi, '')
            .replace(/<\/body>/gi, '');

        if (!cleaned.trim()) {
            return '<p class="warning">AI analysis content is empty</p>';
        }
        return cleaned.trim();
    }
}

module.exports = new AIReportService();
