const express = require('express');
const aiService = require('../services/aiService');
const router = express.Router();

/**
 * 流式AI对话
 * POST /api/ai/chat
 */
router.post('/chat', async (req, res) => {
    const { message, sessionId, context } = req.body;

    if (!message) {
        return res.status(400).json({ error: '消息内容不能为空' });
    }

    // 生成会话ID
    const sid = sessionId || req.ip || 'anonymous';

    try {
        const result = await aiService.chat(sid, message, context || {});

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // 流式发送响应
        for await (const chunk of result.generate()) {
            res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error('AI对话错误:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 生成安全检测报告
 * POST /api/ai/report
 */
router.post('/report', async (req, res) => {
    const { analysisData, fileInfo, toolUsed } = req.body;

    if (!analysisData || !fileInfo) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    try {
        const report = await aiService.generateSecurityReport(analysisData, fileInfo, toolUsed || '分析工具');
        res.json({ success: true, report });
    } catch (error) {
        console.error('报告生成错误:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 分析URL
 * POST /api/ai/analyze-url
 */
router.post('/analyze-url', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL不能为空' });
    }

    try {
        const analysis = await aiService.analyzeURL(url);
        res.json({ success: true, analysis });
    } catch (error) {
        console.error('URL分析错误:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 清除会话历史
 * DELETE /api/ai/session/:sessionId
 */
router.delete('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    aiService.clearSession(sessionId);
    res.json({ success: true, message: '会话已清除' });
});

/**
 * 获取会话历史
 * GET /api/ai/session/:sessionId
 */
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const history = aiService.getSessionHistory(sessionId);
    res.json({ success: true, history });
});

module.exports = router;
