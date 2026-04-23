/**
 * @module middleware/auth
 * @description JWT 认证中间件，验证请求中的 Authorization Token。
 * 验证成功后将用户信息注入 req.user（包含 id 和 username）。
 */

const jwt = require('jsonwebtoken');

/**
 * 获取 JWT Secret，未配置时拒绝请求
 * @returns {string} JWT Secret
 * @throws {Error} 如果 JWT_SECRET 未配置
 */
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET 未配置，服务无法运行');
    }
    return secret;
}

/**
 * 认证中间件 - 验证 Bearer Token
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 * @param {Function} next - Express next 函数
 */
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未提供认证令牌' });
    }

    const token = authHeader.substring(7); // 去掉 "Bearer " 前缀

    try {
        const secret = getJwtSecret();
        const decoded = jwt.verify(token, secret);

        // 将用户信息注入 req.user
        req.user = {
            id: decoded.userId,
            username: decoded.username
        };

        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: '认证令牌已过期' });
        }
        return res.status(401).json({ error: '认证令牌无效' });
    }
}

/**
 * 可选认证中间件 - 如果提供了 Token 则验证，否则继续
 * 用于兼容那些同时支持匿名和认证访问的路由
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 * @param {Function} next - Express next 函数
 */
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null;
        return next();
    }

    const token = authHeader.substring(7);

    try {
        const secret = getJwtSecret();
        const decoded = jwt.verify(token, secret);
        req.user = {
            id: decoded.userId,
            username: decoded.username
        };
    } catch (error) {
        req.user = null;
    }

    next();
}

module.exports = {
    authMiddleware,
    optionalAuth,
    getJwtSecret
};
