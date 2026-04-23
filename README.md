# 邮件安全检测系统

基于MalwareJail沙盒和DeepSeek AI的智能邮件安全检测系统。

## 功能特性

### 核心功能
- ✅ **AI智能交互** - 集成DeepSeek Reasoner API，提供专业的安全分析和建议
- ✅ **沙盒检测** - 使用MalwareJail开源沙盒检测恶意代码和URL
- ✅ **EML邮件解析** - 自动解析EML邮件文件，提取附件并逐个分析
- ✅ **PDF/PPT/图片文本提取** - 支持PDF、PPTX、图片等附件的OCR文本提取
- ✅ **多语言OCR** - 集成Tesseract + EasyOCR，支持中英文图片文字识别
- ✅ **智能报告生成** - 自动生成详细的安全检测报告，支持HTML/PDF下载
- ✅ **实时对话** - 与AI助手实时交流分析结果

### 技术栈
- **后端**: Node.js + Express
- **前端**: 原生JavaScript + Bootstrap 5
- **沙盒**: MalwareJail (JavaScript恶意代码分析)
- **AI**: DeepSeek API (deepseek-reasoner模型)
- **PDF提取**: Python (pdfplumber + PyPDF2 + pdf2image)
- **OCR**: Tesseract OCR + EasyOCR (中英文识别)
- **文件处理**: Multer

---

## 快速开始

### Windows系统（推荐）

双击运行启动脚本：
```
start.bat
```
脚本会自动检查环境、安装依赖并启动服务器。

### 手动启动

```bash
# 1. 安装项目依赖
npm install

# 2. 安装MalwareJail依赖
cd malware-jail && npm install && cd ..

# 3. 安装Python依赖（PDF提取/OCR功能）
pip install pdfplumber PyPDF2 pdf2image pytesseract easyocr Pillow numpy

# 4. 启动服务器
npm start
```

服务器将在 `http://localhost:3000` 启动。

### 环境要求
- **Node.js**: 14.0+
- **Python**: 3.8+（PDF提取/OCR功能需要）
- **Tesseract OCR**: 安装并配置PATH（OCR功能需要，可选）
- **Poppler**: 安装并配置PATH（PDF扫描件OCR需要，可选）

### 配置环境变量

编辑 `.env` 文件：

```env
# DeepSeek API配置
DEEPSEEK_API_KEY=your_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-reasoner

# 服务器配置
PORT=3000

# MalwareJail配置
MALWAREJAIL_PATH=./malware-jail
MALWAREJAIL_OUTPUT_PATH=./malware-jail/output

# 文件上传配置
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=104857600
```

---

## 使用说明

### 手动检测模式

1. 打开浏览器访问 `http://localhost:3000`
2. 拖放文件（JS、HTML、EML、PDF、图片等）到上传区域
3. 点击"开始安全检测"
4. 等待沙盒分析和AI处理
5. 查看分析结果和AI建议
6. 查看详细的安全检测报告

### 支持的文件类型

**深度分析（MalwareJail沙盒）**：
- `.js` - JavaScript脚本
- `.html`, `.htm` - HTML网页
- `.vbs`, `.vbe` - Visual Basic脚本
- `.wsc`, `.wsf` - Windows脚本组件

**AI元数据分析 + 文本提取**：
- `.eml` - 邮件文件（自动解析附件）
- `.pdf` - PDF文档（文本提取 + OCR）
- `.pptx` - PowerPoint演示文稿
- `.jpg`, `.jpeg`, `.png` - 图片（OCR文字识别）
- `.exe`, `.bat`, `.cmd` - 可执行文件
- `.doc`, `.docx`, `.xls`, `.xlsx` - Office文档
- `.zip`, `.rar` - 压缩文件
- `.txt`, `.json` - 文本文件

### EML邮件分析流程

系统对EML邮件文件执行以下分析链路：

```
EML文件上传 → MIME解析 → 附件提取（PDF/PPT/图片/EXE等）
    ↓                                    ↓
邮件头分析（发件人/主题/日期）    逐个附件分析：
    ↓                            - PDF → 文本提取(多策略降级)
AI安全评估                       - PPT → 文本提取(Python-pptx)
    ↓                            - 图片 → OCR识别(Tesseract/EasyOCR)
生成综合报告                     - EXE → 沙盒行为分析
```

### AI对话功能

在聊天界面中与AI助手交互：
- 询问安全问题，如"这个文件的URL安全吗？"
- 请求分析，如"帮我解释这个检测结果"
- AI会结合沙盒分析和附件提取结果给出专业建议

### 报告管理

- 自动生成JSON/HTML格式报告
- 支持导出HTML和PDF格式报告
- 报告包含风险等级、检测统计、URL列表、可疑模式等
- 支持查看历史报告

---

## 风险等级说明

| 等级 | 说明 | 建议操作 |
|------|------|----------|
| 🔴 高风险 | 检测到明显的恶意行为 | 立即删除，不要打开 |
| 🟡 中风险 | 检测到可疑行为 | 谨慎处理，建议隔离检查 |
| 🟢 低风险 | 检测到轻微可疑 | 二次扫描，保持警惕 |
| 🔵 安全 | 未检测到威胁 | 常规检查即可 |

---

## 系统架构

```
邮件安全检测系统
├── server.js                    # 主服务器入口
├── routes/                      # API路由
│   ├── ai.js                    # AI对话和分析
│   ├── sandbox.js               # 沙盒检测 + EML邮件分析
│   ├── upload.js                # 文件上传
│   ├── report.js                # 报告生成/查看/下载
│   └── attachment.js            # 附件分析
├── services/                    # 核心服务
│   ├── aiService.js             # DeepSeek API集成
│   ├── aiReportService.js       # AI报告生成服务
│   ├── sandboxService.js        # MalwareJail集成
│   ├── emailAnalyzer.js         # 邮件解析分析
│   ├── attachmentExtractor.js   # 附件提取(PDF/PPT/图片OCR)
│   ├── pdfExtractorService.js   # PDF提取Node.js封装
│   ├── pdfService.js            # PDF报告生成(pdfkit)
│   ├── pdfBrowserService.js     # PDF浏览器预览
│   ├── formatNormalizer.js      # 格式标准化
│   ├── decompiler.js            # 反编译服务
│   └── quickmu.js               # QuickMu分析
├── pdf_extractor/               # Python PDF/OCR提取模块
│   ├── cli.py                   # CLI接口(Node.js调用)
│   ├── core.py                  # PDFTextExtractor核心
│   ├── ocr_handler.py           # OCR处理(Tesseract+EasyOCR)
│   ├── utils.py                 # 工具函数
│   └── integrations.py          # AI系统集成桥接
├── public/                      # 前端文件
│   ├── index.html               # 主页面
│   └── js/app.js                # 前端逻辑
├── uploads/                     # 上传文件目录
├── reports/                     # 生成的报告目录
└── malware-jail/                # MalwareJail沙盒
```

---

## API文档

### AI相关

#### 流式对话
```http
POST /api/ai/chat
Content-Type: application/json

{
  "message": "用户消息",
  "sessionId": "session-id",
  "context": {}
}
```

#### 生成安全报告
```http
POST /api/ai/report
Content-Type: application/json

{
  "analysisData": {},
  "fileInfo": {},
  "aiReport": ""
}
```

### 沙盒相关

#### 文件分析
```http
POST /api/sandbox/analyze
Content-Type: application/json

{
  "filePath": "path/to/file",
  "fileType": "auto",
  "generateReport": true
}
```

#### URL分析
```http
POST /api/sandbox/analyze-url
Content-Type: application/json

{
  "url": "https://example.com"
}
```

### 文件上传

#### 单文件上传
```http
POST /api/upload/single
Content-Type: multipart/form-data

file: <file>
```

#### 多文件上传
```http
POST /api/upload/multiple
Content-Type: multipart/form-data

files: <files>
```

### 报告相关

#### 生成报告
```http
POST /api/report/generate
Content-Type: application/json

{
  "analysisData": {},
  "fileInfo": {}
}
```

#### 获取报告列表
```http
GET /api/report/list
```

#### 获取单个报告
```http
GET /api/report/:reportId
```

#### 下载HTML报告
```http
GET /api/report/:id/download
```

#### 下载PDF报告
```http
GET /api/report/:id/download/pdf
```

---

## 安全特性

1. **沙盒隔离** - MalwareJail在隔离环境中执行可疑代码
2. **风险评级** - 基于多维度指标评估风险（high/medium/low/safe）
3. **恶意行为检测** - 检测文件操作、网络请求、可疑代码模式
4. **URL分析** - 识别和过滤恶意URL
5. **AI增强** - 结合AI智能分析，提供更准确的安全评估
6. **附件深度检测** - 自动提取PDF/PPT/图片中的文本进行安全分析

---

## 常见问题

### Q1: 服务器启动失败？
- 确认Node.js已安装：`node -v`
- 检查端口占用：`netstat -ano | findstr :3000`
- 重新安装依赖：`npm install`

### Q2: 沙盒分析失败？
- 检查MalwareJail依赖：`cd malware-jail && npm install`
- 使用推荐的文件格式（JS、HTML）
- 查看服务器日志获取详细错误

### Q3: AI响应失败？
- 验证`.env`中的API密钥
- 检查网络连接到api.deepseek.com
- 确认API账户状态

### Q4: PDF/OCR提取不工作？
- 确认Python已安装：`python --version`
- 安装Python依赖：`pip install pdfplumber PyPDF2 pdf2image pytesseract easyocr Pillow numpy`
- Tesseract OCR需单独安装并加入PATH（可选，有EasyOCR兜底）
- Poppler需安装并加入PATH（PDF扫描件OCR需要，可选）

### Q5: 文件上传失败？
- 检查文件大小（默认最大100MB）
- 确认文件类型在支持列表中
- 确保uploads目录有写权限

---

## 设计文档

特性设计文档位于 `.cospec/` 目录：

- `.cospec/pdf-extractor/` - PDF/OCR文本提取模块设计
- `.cospec/report-pdf-download/` - PDF报告下载功能设计

---

## 许可证

MIT License

## 致谢

- [MalwareJail](https://github.com/MalwareJail/MalwareJail) - JavaScript恶意代码分析沙盒
- [DeepSeek](https://www.deepseek.com/) - AI推理模型
- [Bootstrap](https://getbootstrap.com/) - UI框架
- [EasyOCR](https://github.com/JaidedAI/EasyOCR) - 多语言OCR引擎
- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) - OCR引擎
