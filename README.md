邮件安全智能检测系统

基于多引擎检测与 DeepSeek AI 的邮件安全分析平台，支持自动化提取邮件附件、深度分析可疑内容，并生成可读的安全报告。
✨ 已实现的核心功能
1. 邮件解析与附件提取

    ✅ EML 邮件解析：自动解析 MIME 结构，提取发件人、主题、正文及嵌入附件

    ✅ 递归附件提取：遍历多层 MIME 树，处理嵌套邮件、内嵌文件

    ✅ 压缩包解压：支持 zip、rar、7z 等格式，自动解压并递归扫描内部文件

    ✅ 文件类型识别：基于 Magic bytes 识别真实文件类型，防扩展名伪装

2. 深度附件内容提取

    ✅ PDF 文本提取（多策略降级）

        明码 PDF：pdfplumber + PyPDF2

        扫描版 PDF：pdf2image + OCR（Tesseract / EasyOCR）

    ✅ PPT/PPTX 文本提取：python-pptx

    ✅ 图片文字识别（OCR）：支持中英文，Tesseract + EasyOCR 双引擎自动切换

    ✅ Office 文档元数据提取：.doc/.docx/.xls/.xlsx 基本信息提取

3. 恶意代码沙盒分析（MalwareJail）

    ✅ JavaScript 分析：检测恶意行为（eval、document.write、动态重定向等）

    ✅ HTML 页面分析：提取隐藏 iframe、表单劫持、可疑脚本

    ✅ VBS/VBE 等脚本扫描：行为模式识别

    ✅ 沙盒行为报告：输出结构化日志，包含风险等级、可疑动作列表

4. AI 智能研判与报告

    ✅ DeepSeek Reasoner 集成：将邮件头、正文、附件文本、沙盒结果汇总为分析提示词

    ✅ 自然语言风险评估：结合业务上下文判断是否为鱼叉攻击、BEC 诈骗等

    ✅ 多维度风险评级：高/中/低/安全四级，附带判断依据

    ✅ 一键生成报告：HTML/PDF 格式，包含证据链和修复建议

    ✅ 交互式对话：支持与 AI 多轮交流，深入分析可疑点

5. Web 界面

    ✅ 文件拖拽上传，实时进度反馈

    ✅ 报告在线预览与历史管理

    ✅ 响应式界面（Bootstrap 5）

🧱 技术栈
层级	技术
后端	Node.js + Express
前端	Bootstrap 5 + 原生 JavaScript
邮件解析	mailparser
沙盒	MalwareJail
AI 引擎	DeepSeek API (deepseek-reasoner)
PDF/OCR	Python 3 (pdfplumber, PyPDF2, pdf2image, Tesseract, EasyOCR)
文件处理	Multer, unzipper, node-7z
报告生成	pdfkit, Handlebars
📋 当前版本状态（重要）

本项目处于 MVP 迭代阶段，以下功能已经在技术方案中完成调研与原型验证，但由于复杂度或环境要求，暂未整合到主检测链路中，将在后续版本实现。我会清楚的标注出来，以避免项目展示时产生误解。
🔜 规划中 / 已调研但未上线功能
1. 加密 PDF 的自动解密与恶意检测

    技术方案已完成：识别 PDF /Encrypt 字典，提取 V/R/O/U 参数

    已搭建本地原型：pdf2john + John the Ripper 弱口令爆破流程验证

    未集成原因：实际场景中无口令提示的加密 PDF 检出率有限，优先做了明码 PDF 深度分析

2. 全类型文件沙盒动态分析（exe / Office / PDF 脚本）

    当前仅 MalwareJail 用于 JS/HTML/VBS 等脚本分析

    已完成架构调研：技术选型为 Docker 隔离 + 行为监控 Agent，计划集成 CAPE 或 DRAKVUF

    未上线原因：沙盒环境搭建复杂度大，稳定性调优需要较长周期

3. 邮件认证深度验证（SPF/DKIM/DMARC）

    当前已读取邮件头，但未做完整的 DNS 查询与签名验证

    身份验证模块接口已预留，待后续集成

4. URL 动态分析（无头浏览器渲染）

    现有链接检测基于静态规则 + AI 辅助

    已通过 Playwright 验证动态页面追踪与钓鱼特征提取的可行性

    将在下一版本加入正式的动态分析能力

我很欢迎对这些未完成特性进行交流，这里有详细的技术调研报告和原型代码，可以随时展开讨论。
🚀 快速开始
环境要求

    Node.js ≥ 14

    Python ≥ 3.8

    （可选）Tesseract OCR 与 Poppler（用于图片/扫描件 OCR）

一步启动（Windows）

双击 start.bat 即可自动安装依赖并启动服务器。
手动命令
bash

# 1. 安装 Node 依赖
npm install

# 2. 进入 MalwareJail 目录安装依赖
cd malware-jail && npm install && cd ..

# 3. 安装 Python 依赖
pip install pdfplumber PyPDF2 pdf2image pytesseract easyocr Pillow numpy

# 4. 启动
npm start

访问 http://localhost:3000
🔒 安全提示

    本系统仅用于授权邮件检测与安全研究

    请勿上传敏感企业邮件至不受控环境

    沙盒分析结果供参考，最终判断需人工复核

📄 许可证

MIT License