/**
 * @module routes/auth
 * @description 认证路由模块，提供注册、登录、令牌验证、账号注销等 API 端点。
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const userService = require('../services/userService');
const { getJwtSecret } = require('../middleware/auth');

const router = express.Router();

/**
 * 获取客户端 IP 地址
 * @param {Object} req - Express 请求对象
 * @returns {string} IP 地址
 */
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection.remoteAddress;
}

/**
 * POST /api/auth/register
 * 用户注册
 */
router.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const ip = getClientIp(req);

        // 频率限制检查
        if (userService.checkRegisterRateLimit(ip)) {
            return res.status(429).json({ error: '注册请求过于频繁，请稍后再试' });
        }

        const result = userService.registerUser(username, password);

        // 记录注册尝试
        userService.logRegisterAttempt(ip, username, result.success);

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        // 注册成功，生成 Token
        const secret = getJwtSecret();
        const expiresIn = process.env.TOKEN_EXPIRES_IN || '2h';
        const token = jwt.sign(
            { userId: result.user.id, username: result.user.username },
            secret,
            { expiresIn }
        );

        res.status(201).json({
            success: true,
            message: '注册成功',
            token,
            user: {
                id: result.user.id,
                username: result.user.username
            }
        });
    } catch (error) {
        console.error('注册失败:', error);
        res.status(500).json({ error: '注册过程中发生错误' });
    }
});

/**
 * POST /api/auth/login
 * 用户登录
 */
router.post('/login', async (req, res) => {
    try {
        const { username, password, rememberMe } = req.body;
        const ip = getClientIp(req);

        // 频率限制检查
        if (userService.checkLoginRateLimit(ip)) {
            return res.status(429).json({ error: '登录请求过于频繁，请稍后再试' });
        }

        const result = userService.loginUser(username, password);

        // 记录登录尝试
        userService.logLoginAttempt(ip, username, result.success);

        if (!result.success) {
            return res.status(401).json({ error: result.error });
        }

        // 生成 Token
        const secret = getJwtSecret();
        const expiresIn = rememberMe
            ? (process.env.TOKEN_REMEMBER_EXPIRES_IN || '7d')
            : (process.env.TOKEN_EXPIRES_IN || '2h');

        const token = jwt.sign(
            { userId: result.user.id, username: result.user.username },
            secret,
            { expiresIn }
        );

        res.json({
            success: true,
            message: '登录成功',
            token,
            user: {
                id: result.user.id,
                username: result.user.username
            }
        });
    } catch (error) {
        console.error('登录失败:', error);
        res.status(500).json({ error: '登录过程中发生错误' });
    }
});

/**
 * DELETE /api/auth/account
 * 注销当前用户账号，删除所有关联数据和文件
 */
router.delete('/account', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: '未提供认证令牌' });
        }

        const token = authHeader.substring(7);
        const secret = getJwtSecret();
        const decoded = jwt.verify(token, secret);

        const userId = decoded.userId;
        const username = decoded.username;

        // 验证用户是否存在
        const user = userService.getUserById(userId);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        // 删除用户的上传文件目录
        const uploadDir = process.env.UPLOAD_DIR || './uploads';
        const userUploadDir = path.join(uploadDir, `user_${username}`);
        if (fs.existsSync(userUploadDir)) {
            fs.rmSync(userUploadDir, { recursive: true, force: true });
        }
        // 也尝试删除旧格式目录（兼容历史数据）
        const oldUploadDir = path.join(uploadDir, `user_${userId}`);
        if (fs.existsSync(oldUploadDir)) {
            fs.rmSync(oldUploadDir, { recursive: true, force: true });
        }

        // 删除用户的报告文件目录
        const reportDir = process.env.REPORT_DIR || './reports';
        const userReportDir = path.join(reportDir, `user_${username}`);
        if (fs.existsSync(userReportDir)) {
            fs.rmSync(userReportDir, { recursive: true, force: true });
        }
        // 也尝试删除旧格式目录（兼容历史数据）
        const oldReportDir = path.join(reportDir, `user_${userId}`);
        if (fs.existsSync(oldReportDir)) {
            fs.rmSync(oldReportDir, { recursive: true, force: true });
        }

        // 删除数据库中的记录
        const result = userService.deleteUser(userId);
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            success: true,
            message: '账号已成功注销，所有数据已删除'
        });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: '认证令牌已过期' });
        }
        console.error('账号注销失败:', error);
        res.status(500).json({ error: '账号注销过程中发生错误' });
    }
});

/**
 * GET /api/auth/verify
 * 验证 Token 是否有效
 */
router.get('/verify', (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ valid: false, error: '未提供认证令牌' });
        }

        const token = authHeader.substring(7);
        const secret = getJwtSecret();
        const decoded = jwt.verify(token, secret);

        // 获取最新用户信息
        const user = userService.getUserById(decoded.userId);
        if (!user) {
            return res.status(401).json({ valid: false, error: '用户不存在' });
        }

        res.json({
            valid: true,
            user: {
                id: user.id,
                username: user.username
            }
        });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ valid: false, error: '认证令牌已过期' });
        }
        return res.status(401).json({ valid: false, error: '认证令牌无效' });
    }
});

module.exports = router;
