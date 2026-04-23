const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// API配置 - DeepSeek官方API
const API_KEY = 'sk-12109df04a8a4602b2a0a5f0536cb39f';
const API_BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-reasoner';

// 获取真实API基础URL（通过OpenAI SDK的配置）
const getBaseUrl = () => {
    // OpenAI SDK默认会尝试访问api.openai.com
    // 我们强制使用deepseek的baseURL
    return API_BASE_URL;
};

// 初始化DeepSeek客户端
const deepseekClient = new OpenAI({
    apiKey: API_KEY,
    baseURL: getBaseUrl()
});

/**
 * AI服务类 - 处理与DeepSeek的交互
 */
class AIService {
    constructor() {
        this.model = process.env.DEEPSEEK_MODEL || 'deepseek-reasoner';
        this.conversationHistory = new Map(); // 存储会话历史
    }

    /**
     * 生成系统提示词
     */
    getSystemPrompt() {
        return `你是一个专业的邮件安全检测专家和代码安全分析师。你的任务是对用户提供的文件内容进行深度安全分析。

你的职责：
1. 直接分析用户提供的文件内容，识别潜在的安全威胁和恶意行为
2. 提取并分析文件中的URL、域名、IP地址等网络指标
3. 识别可疑的代码模式、混淆技术、反分析机制
4. 分析文件结构、文件头信息、元数据
5. 评估恶意行为的可能性、利用难度和潜在影响
6. 生成专业的安全检测报告
7. 提供针对性的安全建议和修复措施

分析重点：
- 网络活动：外部连接、域名解析、数据传输、C2通信
- 文件操作：文件读写、系统配置修改、敏感文件访问
- 恶意行为：代码注入、进程操作、注册表修改、权限提升
- 可疑模式：混淆技术、反调试、已知恶意特征
- 威胁情报：已知威胁匹配、攻击模式识别

请用中文进行所有分析，保持专业、清晰、准确的语言风格。对于每个发现的安全问题，要详细说明：
- 风险等级（安全/低风险/中等风险/高风险/严重风险）
- 潜在威胁和影响范围
- 利用的可能性
- 具体的应对建议和修复步骤`;
    }

    /**
     * 发送消息到DeepSeek API
     * @param {string} sessionId - 会话ID
     * @param {string} userMessage - 用户消息
     * @param {object} context - 上下文信息（沙盒结果等）
     */
    async chat(sessionId, userMessage, context = {}) {
        // 从context中获取工具名称
        const toolName = context.toolUsed || '分析工具';
        const maxRetries = 3;
        let retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                // 获取或初始化会话历史
                if (!this.conversationHistory.has(sessionId)) {
                    this.conversationHistory.set(sessionId, [
                        {
                            role: 'system',
                            content: this.getSystemPrompt()
                        }
                    ]);
                }

                const history = this.conversationHistory.get(sessionId);

                // 如果有上下文信息，添加到消息中
                let enhancedMessage = userMessage;
                if (context.analyResults) {
                    enhancedMessage += `\n\n【${toolName}分析结果】\n${JSON.stringify(context.analyResults, null, 2)}`;
                }
                if (context.fileInfo) {
                    enhancedMessage += `\n\n【文件信息】\n文件名: ${context.fileInfo.filename}\n文件大小: ${context.fileInfo.size} bytes\n分析工具: ${toolName}`;
                }

                // 添加用户消息
                history.push({
                    role: 'user',
                    content: enhancedMessage
                });

                // 限制历史记录长度，避免token超限
                if (history.length > 15) {
                    // 保留系统提示和最近14条消息
                    const simplifiedHistory = [history[0], ...history.slice(-14)];
                    this.conversationHistory.set(sessionId, simplifiedHistory);
                }

                // 调用DeepSeek API
                const response = await deepseekClient.chat.completions.create({
                    model: this.model,
                    messages: history,
                    temperature: 0.7,
                    max_tokens: 4000, // 增加到4000 tokens
                    stream: true, // 启用流式传输
                    presence_penalty: 0.1,
                    frequency_penalty: 0.1
                });

                // 处理流式响应
                return {
                    type: 'stream',
                    async *generate() {
                        let fullContent = '';
                        for await (const chunk of response) {
                            const content = chunk.choices[0]?.delta?.content || '';
                            if (content) {
                                fullContent += content;
                                yield content;
                            }
                        }

                        // 将AI回复添加到历史
                        history.push({
                            role: 'assistant',
                            content: fullContent
                        });
                    }
                };
            } catch (error) {
                console.error(`AI服务错误 (尝试 ${retryCount + 1}/${maxRetries}):`, error);
                retryCount++;

                // 如果是token限制错误，尝试简化请求
                if (error.message?.includes('maximum context length') && retryCount < maxRetries) {
                    console.log('检测到上下文长度限制，简化历史记录后重试...');
                    // 保留系统提示和最近5条消息
                    const history = this.conversationHistory.get(sessionId);
                    if (history && history.length > 6) {
                        const simplifiedHistory = [
                            history[0], // 系统提示
                            ...history.slice(-5) // 最近5条消息
                        ];
                        this.conversationHistory.set(sessionId, simplifiedHistory);
                    }
                    continue;
                }

                // 网络错误或超时，等待后重试
                if (retryCount < maxRetries) {
                    const waitTime = Math.pow(2, retryCount) * 1000; // 指数退避：2s, 4s, 8s
                    console.log(`等待 ${waitTime / 1000} 秒后重试...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                throw new Error(`AI服务调用失败: ${error.message}`);
            }
        }
    }

    /**
     * 生成安全检测报告
     * @param {object} analysisData - 分析数据
     * @param {object} fileInfo - 文件信息
     * @param {string} toolUsed - 使用的工具名称
     */
    async generateSecurityReport(analysisData, fileInfo, toolUsed) {
        try {
            const toolName = toolUsed || '分析工具';
            const prompt = `请根据以下${toolName}分析数据，生成一份详细的邮件安全检测报告：

【文件信息】
- 文件名: ${fileInfo.filename}
- 文件大小: ${fileInfo.size} bytes
- 文件类型: ${fileInfo.mimetype}
- 分析工具: ${toolName}

【${toolName}分析结果】
${JSON.stringify(analysisData, null, 2)}

请生成结构化的报告，包含以下部分：
1. 执行摘要
2. 威胁等级评估
3. 检测到的恶意行为（如果有）
4. 网络活动分析
5. 文件系统操作
6. 风险建议
7. 结论`;

            const response = await deepseekClient.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个专业的安全分析师，擅长生成详细的网络安全报告。'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.3,
                max_tokens: 6000, // 增加到6000 tokens以支持更长的报告
                presence_penalty: 0.1,
                frequency_penalty: 0.1
            });

            return response.choices[0].message.content;
        } catch (error) {
            console.error('生成报告失败:', error);
            throw new Error(`报告生成失败: ${error.message}`);
        }
    }

    /**
     * 分析URL安全性
     * @param {string} url - 待分析的URL
     */
    async analyzeURL(url) {
        try {
            const prompt = `请分析以下URL的安全风险，并提供详细的评估报告：

URL: ${url}

请评估：
1. 域名信誉度
2. URL结构是否可疑
3. 是否使用HTTP而非HTTPS
4. 是否包含可疑参数
5. 短链服务风险评估

给出最终的风险评级（低风险/中风险/高风险）。`;

            const response = await deepseekClient.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个URL安全分析专家。'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.5,
                max_tokens: 1500
            });

            return response.choices[0].message.content;
        } catch (error) {
            console.error('URL分析失败:', error);
            throw new Error(`URL分析失败: ${error.message}`);
        }
    }

    /**
     * 清除会话历史
     * @param {string} sessionId - 会话ID
     */
    clearSession(sessionId) {
        this.conversationHistory.delete(sessionId);
    }

    /**
     * 获取会话历史
     * @param {string} sessionId - 会话ID
     */
    getSessionHistory(sessionId) {
        return this.conversationHistory.get(sessionId) || [];
    }
}

// 导出单例
module.exports = new AIService();
