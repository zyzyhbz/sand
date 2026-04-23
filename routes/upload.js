const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const pdfExtractorService = require('../services/pdfExtractorService');

// 配置上传目录
const uploadDir = process.env.UPLOAD_DIR || './uploads';

// 确保上传目录存在
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 配置multer存储
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // 使用用户子目录存储文件
        const username = req.user ? req.user.username : 'anonymous';
        const userDir = path.join(uploadDir, `user_${username}`);
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        cb(null, userDir);
    },
    filename: function (req, file, cb) {
        // 生成唯一文件名
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        // 处理中文文件名编码问题
        let baseName = path.basename(file.originalname, ext);
        // 如果文件名有编码问题，尝试修复
        try {
            // 在Windows环境下，尝试将乱码转换回UTF-8
            const iconv = require('iconv-lite');
            // 尝试从GB2312/GBK转换（Windows默认）
            const decodedName = iconv.decode(Buffer.from(baseName, 'binary'), 'utf8');
            // 检查解码后的名称是否包含非ASCII字符，如果包含说明可能已经修复
            if (decodedName !== baseName && /[^\x00-\x7F]/.test(decodedName)) {
                baseName = decodedName;
            }
        } catch (e) {
            // 如果转换失败，保持原样
            console.log('文件名编码转换失败，使用原名称:', e.message);
        }
        cb(null, `${baseName}-${uniqueSuffix}${ext}`);
    }
});

// 配置multer
const upload = multer({
    storage: storage,
    limits: {
        fileSize: parseInt(process.env.MAX_FILE_SIZE) || 104857600, // 默认100MB
        files: 10
    },
    fileFilter: function (req, file, cb) {
        // 允许的文件类型
        const allowedTypes = [
            '.js', '.html', '.htm', '.json', '.txt',
            '.pdf', '.doc', '.docx', '.xls', '.xlsx',
            '.eml', '.msg', '.zip', '.rar',
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff',
            '.exe', '.vbs', '.bat', '.cmd'
        ];

        const ext = path.extname(file.originalname).toLowerCase();

        if (allowedTypes.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件类型: ${ext}`), false);
        }
    }
});

/**
 * 单文件上传
 * POST /api/upload/single
 */
router.post('/single', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '没有上传文件' });
        }

        const fileInfo = {
            filename: req.file.filename,
            originalname: req.file.originalname,
            path: req.file.path,
            size: req.file.size,
            mimetype: req.file.mimetype,
            uploadTime: new Date().toISOString()
        };

        res.json({
            success: true,
            message: '文件上传成功',
            file: fileInfo
        });

    } catch (error) {
        console.error('文件上传失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 多文件上传
 * POST /api/upload/multiple
 */
router.post('/multiple', upload.array('files', 10), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: '没有上传文件' });
        }

        const filesInfo = req.files.map(file => ({
            filename: file.filename,
            originalname: file.originalname,
            path: file.path,
            size: file.size,
            mimetype: file.mimetype,
            uploadTime: new Date().toISOString()
        }));

        res.json({
            success: true,
            message: `成功上传 ${filesInfo.length} 个文件`,
            files: filesInfo,
            count: filesInfo.length
        });

    } catch (error) {
        console.error('文件上传失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 上传并分析文件
 * POST /api/upload/analyze
 */
router.post('/analyze', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '没有上传文件' });
        }

        const fileInfo = {
            filename: req.file.filename,
            originalname: req.file.originalname,
            path: req.file.path,
            size: req.file.size,
            mimetype: req.file.mimetype
        };

        const fileType = req.body.fileType || 'auto';
        const fileExt = path.extname(req.file.originalname).toLowerCase();

        // 如果是PDF文件，自动提取文本内容
        let pdfExtractedText = '';
        let pdfMetadata = null;
        if (fileExt === '.pdf') {
            try {
                console.log(`[上传路由] 检测到PDF文件，开始提取文本: ${req.file.path}`);
                const extractResult = await pdfExtractorService.extractFromFile(req.file.path);

                if (extractResult.success && extractResult.data) {
                    pdfExtractedText = extractResult.data.extracted_text || '';
                    pdfMetadata = {
                        statistics: extractResult.data.statistics || null,
                        qualityIndicators: extractResult.data.quality_indicators || null,
                        summary: extractResult.data.summary || '',
                        method: extractResult.method || 'unknown',
                        truncated: extractResult.compatibility?.truncated || false
                    };
                    console.log(`[上传路由] PDF文本提取成功, 文本长度: ${pdfExtractedText.length}`);
                } else {
                    console.warn(`[上传路由] PDF文本提取失败: ${extractResult.error || '未知错误'}`);
                }
            } catch (pdfError) {
                console.error(`[上传路由] PDF文本提取异常:`, pdfError);
            }
        }

        res.json({
            success: true,
            message: '文件上传成功，准备分析',
            file: fileInfo,
            fileType: fileType,
            // PDF提取结果
            pdfExtractedText: pdfExtractedText || undefined,
            pdfMetadata: pdfMetadata || undefined
        });

    } catch (error) {
        console.error('文件上传失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 删除文件
 * DELETE /api/upload/file/:filename
 */
router.delete('/file/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        const filePath = path.join(uploadDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '文件不存在' });
        }

        fs.unlinkSync(filePath);

        res.json({
            success: true,
            message: '文件删除成功',
            filename: filename
        });

    } catch (error) {
        console.error('文件删除失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 获取文件信息
 * GET /api/upload/file/:filename/info
 */
router.get('/file/:filename/info', (req, res) => {
    try {
        const { filename } = req.params;
        const filePath = path.join(uploadDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const stats = fs.statSync(filePath);

        const fileInfo = {
            filename: filename,
            path: filePath,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            mimetype: path.extname(filename).replace('.', '')
        };

        res.json({
            success: true,
            file: fileInfo
        });

    } catch (error) {
        console.error('获取文件信息失败:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 列出已上传的文件
 * GET /api/upload/files
 */
router.get('/files', (req, res) => {
    try {
        if (!fs.existsSync(uploadDir)) {
            return res.json({ success: true, files: [] });
        }

        const files = fs.readdirSync(uploadDir)
            .filter(f => {
                const filePath = path.join(uploadDir, f);
                const stats = fs.statSync(filePath);
                return stats.isFile();
            })
            .map(filename => {
                const filePath = path.join(uploadDir, filename);
                const stats = fs.statSync(filePath);

                return {
                    filename: filename,
                    path: filePath,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                };
            })
            .sort((a, b) => b.created - a.created); // 按创建时间降序排序

        res.json({
            success: true,
            count: files.length,
            files: files
        });

    } catch (error) {
        console.error('列出文件失败:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
