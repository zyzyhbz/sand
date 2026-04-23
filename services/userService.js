/**
 * @module services/userService
 * @description 用户服务模块，封装所有用户相关的数据库操作。
 * 包括用户注册、登录验证、查询等功能。
 */

const bcrypt = require('bcryptjs');
const { getDatabase } = require('../database/init');

const SALT_ROUNDS = 10;

/**
 * 用户名验证：3-20位，只允许字母、数字和下划线
 * @param {string} username - 待验证的用户名
 * @returns {boolean} 是否合法
 */
function isValidUsername(username) {
    return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

/**
 * 密码验证：最少6位
 * @param {string} password - 待验证的密码
 * @returns {boolean} 是否合法
 */
function isValidPassword(password) {
    return typeof password === 'string' && password.length >= 6;
}

/**
 * 注册新用户
 * @param {string} username - 用户名
 * @param {string} password - 密码
 * @returns {Object} { success, user?, error? }
 */
function registerUser(username, password) {
    // 参数验证
    if (!username || !password) {
        return { success: false, error: '用户名和密码不能为空' };
    }

    if (!isValidUsername(username)) {
        return { success: false, error: '用户名须为3-20位，只允许字母、数字和下划线' };
    }

    if (!isValidPassword(password)) {
        return { success: false, error: '密码长度至少6位' };
    }

    const db = getDatabase();

    // 检查用户名是否已存在
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
        return { success: false, error: '用户名已被注册' };
    }

    // 密码哈希
    const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

    // 插入用户
    const result = db.prepare(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run(username, passwordHash);

    return {
        success: true,
        user: {
            id: result.lastInsertRowid,
            username: username
        }
    };
}

/**
 * 用户登录验证
 * @param {string} username - 用户名
 * @param {string} password - 密码
 * @returns {Object} { success, user?, error? }
 */
function loginUser(username, password) {
    if (!username || !password) {
        return { success: false, error: '用户名和密码不能为空' };
    }

    const db = getDatabase();

    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
    if (!user) {
        return { success: false, error: '用户名或密码错误' };
    }

    const passwordMatch = bcrypt.compareSync(password, user.password_hash);
    if (!passwordMatch) {
        return { success: false, error: '用户名或密码错误' };
    }

    // 更新最后登录时间
    db.prepare('UPDATE users SET last_login = datetime(\'now\', \'localtime\') WHERE id = ?').run(user.id);

    return {
        success: true,
        user: {
            id: user.id,
            username: user.username
        }
    };
}

/**
 * 根据用户ID获取用户信息
 * @param {number} userId - 用户ID
 * @returns {Object|null} 用户信息（不含密码哈希）
 */
function getUserById(userId) {
    const db = getDatabase();
    const user = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE id = ?').get(userId);
    return user || null;
}

/**
 * 根据用户名获取用户信息
 * @param {string} username - 用户名
 * @returns {Object|null} 用户信息（不含密码哈希）
 */
function getUserByUsername(username) {
    const db = getDatabase();
    const user = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE username = ?').get(username);
    return user || null;
}

/**
 * 记录登录日志
 * @param {string} ipAddress - 客户端IP地址
 * @param {string} username - 尝试的用户名
 * @param {boolean} success - 是否成功
 */
function logLoginAttempt(ipAddress, username, success) {
    const db = getDatabase();
    db.prepare(
        'INSERT INTO login_logs (ip_address, username, success) VALUES (?, ?, ?)'
    ).run(ipAddress, username || '', success ? 1 : 0);
}

/**
 * 检查IP的登录频率限制
 * @param {string} ipAddress - 客户端IP地址
 * @param {number} maxAttempts - 最大尝试次数
 * @param {number} windowMinutes - 时间窗口（分钟）
 * @returns {boolean} 是否超过限制（true=已超限）
 */
function checkLoginRateLimit(ipAddress, maxAttempts = 10, windowMinutes = 1) {
    const db = getDatabase();
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const result = db.prepare(
        'SELECT COUNT(*) as count FROM login_logs WHERE ip_address = ? AND created_at > ?'
    ).get(ipAddress, cutoff);
    return result.count >= maxAttempts;
}

/**
 * 检查IP的注册频率限制
 * @param {string} ipAddress - 客户端IP地址
 * @param {number} maxAttempts - 最大尝试次数
 * @param {number} windowMinutes - 时间窗口（分钟）
 * @returns {boolean} 是否超过限制（true=已超限）
 */
function checkRegisterRateLimit(ipAddress, maxAttempts = 5, windowMinutes = 1) {
    // 注册操作复用 login_logs 表记录，通过 username 前缀区分
    const db = getDatabase();
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const result = db.prepare(
        `SELECT COUNT(*) as count FROM login_logs 
         WHERE ip_address = ? AND created_at > ? AND username LIKE '[REGISTER]%'`
    ).get(ipAddress, cutoff);
    return result.count >= maxAttempts;
}

/**
 * 记录注册尝试
 * @param {string} ipAddress - 客户端IP地址
 * @param {string} username - 注册的用户名
 * @param {boolean} success - 是否成功
 */
function logRegisterAttempt(ipAddress, username, success) {
    const db = getDatabase();
    db.prepare(
        'INSERT INTO login_logs (ip_address, username, success) VALUES (?, ?, ?)'
    ).run(ipAddress, `[REGISTER]${username}`, success ? 1 : 0);
}

/**
 * 保存报告元数据到数据库
 * @param {number} userId - 用户ID
 * @param {Object} reportMeta - 报告元数据
 * @returns {Object} { success, id? }
 */
function saveReportMeta(userId, reportMeta) {
    const db = getDatabase();
    try {
        const result = db.prepare(
            `INSERT INTO reports (user_id, report_id, display_id, file_name, risk_level, file_path)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
            userId,
            reportMeta.reportId,
            reportMeta.displayId || '',
            reportMeta.fileName || '',
            reportMeta.riskLevel || 'unknown',
            reportMeta.filePath || ''
        );
        return { success: true, id: result.lastInsertRowid };
    } catch (error) {
        console.error('保存报告元数据失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 获取用户的报告列表
 * @param {number} userId - 用户ID
 * @returns {Array} 报告元数据列表
 */
function getReportsByUserId(userId) {
    const db = getDatabase();
    return db.prepare(
        'SELECT * FROM reports WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);
}

/**
 * 获取单个报告元数据
 * @param {number} userId - 用户ID
 * @param {string} reportId - 报告ID
 * @returns {Object|null} 报告元数据
 */
function getReportMeta(userId, reportId) {
    const db = getDatabase();
    return db.prepare(
        'SELECT * FROM reports WHERE user_id = ? AND report_id = ?'
    ).get(userId, reportId);
}

/**
 * 删除报告元数据
 * @param {number} userId - 用户ID
 * @param {string} reportId - 报告ID
 * @returns {boolean} 是否删除成功
 */
function deleteReportMeta(userId, reportId) {
    const db = getDatabase();
    const result = db.prepare(
        'DELETE FROM reports WHERE user_id = ? AND report_id = ?'
    ).run(userId, reportId);
    return result.changes > 0;
}
/**
 * 更新报告的风险等级
 * @param {number} userId - 用户ID
 * @param {string} reportId - 报告ID
 * @param {string} riskLevel - 新的风险等级
 * @returns {Object} { success, changes? }
 */
function updateReportRiskLevel(userId, reportId, riskLevel) {
    const db = getDatabase();
    try {
        const result = db.prepare(
            'UPDATE reports SET risk_level = ? WHERE user_id = ? AND report_id = ?'
        ).run(riskLevel, userId, reportId);
        return { success: true, changes: result.changes };
    } catch (error) {
        console.error('更新报告风险等级失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 删除用户的所有报告元数据
 * @param {number} userId - 用户ID
 * @returns {number} 删除的记录数
 */
function deleteAllUserReports(userId) {
    const db = getDatabase();
    const result = db.prepare('DELETE FROM reports WHERE user_id = ?').run(userId);
    return result.changes;
}

/**
 * 删除用户账号及其所有关联数据
 * @param {number} userId - 用户ID
 * @returns {Object} { success, error? }
 */
function deleteUser(userId) {
    const db = getDatabase();
    try {
        // 删除用户的所有报告元数据
        db.prepare('DELETE FROM reports WHERE user_id = ?').run(userId);
        // 删除用户账号
        const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        if (result.changes === 0) {
            return { success: false, error: '用户不存在' };
        }
        return { success: true };
    } catch (error) {
        console.error('删除用户失败:', error);
        return { success: false, error: '删除用户失败' };
    }
}

module.exports = {
    registerUser,
    loginUser,
    getUserById,
    getUserByUsername,
    logLoginAttempt,
    checkLoginRateLimit,
    checkRegisterRateLimit,
    logRegisterAttempt,
    saveReportMeta,
    getReportsByUserId,
    getReportMeta,
    deleteReportMeta,
    deleteAllUserReports,
    deleteUser,
    updateReportRiskLevel,
    isValidUsername,
    isValidPassword
};
