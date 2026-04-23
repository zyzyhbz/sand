/**
 * @module database/init
 * @description SQLite 数据库初始化模块，负责创建和管理数据库连接实例。
 * 使用单例模式管理数据库连接，集中管理表结构变更。
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'app.db');

// 确保数据库目录存在
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

let db = null;

/**
 * 初始化数据库连接并创建表结构
 * @returns {Database} better-sqlite3 数据库实例
 */
function initDatabase() {
    if (db) {
        return db;
    }

    db = new Database(DB_PATH);

    // 启用 WAL 模式提升并发性能
    db.pragma('journal_mode = WAL');
    // 启用外键约束
    db.pragma('foreign_keys = ON');

    // 创建用户表
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            last_login TEXT
        )
    `);

    // 创建报告元数据表
    db.exec(`
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            report_id TEXT UNIQUE NOT NULL,
            display_id TEXT,
            file_name TEXT,
            risk_level TEXT,
            file_path TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // 创建登录日志表（用于频率限制审计）
    db.exec(`
        CREATE TABLE IF NOT EXISTS login_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address TEXT NOT NULL,
            username TEXT,
            success INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    console.log(`✅ 数据库初始化完成: ${DB_PATH}`);
    return db;
}

/**
 * 获取数据库实例
 * @returns {Database} better-sqlite3 数据库实例
 * @throws {Error} 如果数据库未初始化
 */
function getDatabase() {
    if (!db) {
        return initDatabase();
    }
    return db;
}

/**
 * 关闭数据库连接
 */
function closeDatabase() {
    if (db) {
        db.close();
        db = null;
        console.log('✅ 数据库连接已关闭');
    }
}

module.exports = {
    initDatabase,
    getDatabase,
    closeDatabase
};
