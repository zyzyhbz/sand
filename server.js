const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// 加载环境变量（显式指定UTF-8编码，必须在其他模块之前）
const envConfig = dotenv.config({
    encoding: 'utf8'
});

// 检查 JWT_SECRET 是否配置
if (!process.env.JWT_SECRET) {
    console.error('❌ 错误: JWT_SECRET 未配置，请在 .env 文件中设置');
    process.exit(1);
}

// 初始化数据库
const { initDatabase } = require('./database/init');
initDatabase();

// 导入路由模块
const aiRouter = require('./routes/ai');
const sandboxRouter = require('./routes/sandbox');
const uploadRouter = require('./routes/upload');
const reportRouter = require('./routes/report');
const attachmentRouter = require('./routes/attachment');
const authRouter = require('./routes/auth');

// 导入认证中间件
const { authMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// 创建必要的目录
const dirs = [
    process.env.UPLOAD_DIR || './uploads',
    process.env.MALWAREJAIL_OUTPUT_PATH || './malware-jail/output',
    './reports'
];

dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`创建目录: ${dir}`);
    }
});

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 静态文件服务（不需要认证）
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/reports', express.static(path.join(__dirname, 'reports')));

// 公开路由（不需要认证）
app.use('/api/auth', authRouter);

// 健康检查端点（不需要认证）
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            server: 'running',
            malwarejail: 'available',
            deepseek: 'configured'
        }
    });
});

// 登录页面路由
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 受保护的 API 路由（需要认证）
app.use('/api/ai', authMiddleware, aiRouter);
app.use('/api/sandbox', authMiddleware, sandboxRouter);
app.use('/api/upload', authMiddleware, uploadRouter);
app.use('/api/report', authMiddleware, reportRouter);
app.use('/api/attachment', authMiddleware, attachmentRouter);

// 根路由（主页）
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error('错误:', err);
    res.status(500).json({
        error: '服务器内部错误',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// 404处理
app.use((req, res) => {
    res.status(404).json({
        error: '路径未找到',
        path: req.path
    });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   邮件安全检测系统已启动                ║
║   服务器运行在 http://localhost:${PORT}  ║
╚════════════════════════════════════════╝
    `);
    console.log('✅ 后端服务启动成功');
    console.log('✅ API端点已就绪');
    console.log('✅ 用户认证系统已启用');
    console.log(`✅ 上传目录: ${process.env.UPLOAD_DIR || './uploads'}`);
    console.log(`✅ MalwareJail路径: ${process.env.MALWAREJAIL_PATH || './malware-jail'}`);
});

module.exports = app;
