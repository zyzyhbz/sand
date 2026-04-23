# 任务清单 - PDF报告下载功能

## 任务概览

本任务清单将PDF报告下载功能拆解为5个可独立执行的任务，每个任务都对应明确的需求和设计点。

- [x] 1. 安装pdfkit依赖包
- [x] 2. 创建PDF转换服务模块
- [x] 3. 添加PDF下载API端点
- [x] 4. 添加前端PDF下载按钮样式
- [x] 5. 实现前端PDF下载功能

---

## 详细任务清单

### 任务1: 安装pdfkit依赖包

**目标**: 在项目中安装PDF生成库pdfkit

**执行步骤**:
1. 在项目根目录执行 `npm install pdfkit`
2. 更新 package.json 的 dependencies 字段添加 pdfkit 依赖
3. 验证安装成功

**需求关联**: FR-002 (服务端HTML到PDF转换功能)

**测试点**: 
- pdfkit包成功安装
- package.json包含pdfkit依赖

---

### 任务2: 创建PDF转换服务模块

**目标**: 创建 services/pdfService.js 模块，实现HTML到PDF的转换功能

**执行步骤**:
1. 在 services 目录下创建 pdfService.js 文件
2. 实现 convertHtmlToPdf 函数，接受HTML内容和配置选项
3. 实现 stripHtml 辅助函数，用于提取纯文本内容
4. 添加错误处理和超时控制（30秒）
5. 导出模块

**需求关联**: FR-002 (服务端HTML到PDF转换功能), FR-003 (转换失败处理机制)

**测试点**: 
- pdfService模块成功导出convertHtmlToPdf函数
- 函数能正确处理HTML内容并返回PDF Buffer
- 错误情况下能正确抛出异常

---

### 任务3: 添加PDF下载API端点

**目标**: 在 routes/report.js 中添加 PDF 下载 API 端点

**执行步骤**:
1. 在 routes/report.js 中引入 pdfService 模块
2. 添加新路由 `GET /:id/download/pdf`
3. 实现路由处理函数:
   - 读取报告JSON文件
   - 生成HTML内容（调用现有 generateHTMLReport 函数）
   - 调用 pdfService 转换HTML为PDF
   - 设置正确的响应头（Content-Type: application/pdf）
   - 返回PDF文件
4. 添加完善的错误处理:
   - 报告不存在返回404
   - 转换失败返回500并记录日志

**需求关联**: FR-002 (服务端HTML到PDF转换功能), FR-003 (转换失败处理机制), FR-004 (PDF下载API端点)

**测试点**:
- API端点 `GET /api/report/:id/download/pdf` 可访问
- 返回的Content-Type为application/pdf
- 响应头包含正确的Content-Disposition
- 报告不存在时返回404错误
- 转换失败时返回500错误并提供fallback链接

---

### 任务4: 添加前端PDF下载按钮样式

**目标**: 在 public/index.html 中添加PDF下载按钮的样式

**执行步骤**:
1. 在 index.html 的 `<style>` 标签中添加 `.btn-download-pdf` 样式类
2. 样式应与现有下载按钮风格一致（红色渐变背景）

**需求关联**: FR-001 (在报告查看页面增加PDF下载按钮)

**测试点**:
- CSS样式正确应用到按钮元素

---

### 任务5: 实现前端PDF下载功能

**目标**: 在 public/js/app.js 中实现PDF下载功能

**执行步骤**:
1. 在 public/js/app.js 中添加 `downloadPdfReport()` 函数
2. 实现函数逻辑:
   - 调用 `/api/report/:id/download/pdf` API
   - 处理响应，获取PDF Blob
   - 从响应头获取文件名
   - 触发浏览器下载
3. 添加错误处理:
   - 显示加载状态
   - 错误时弹出确认框，提示用户是否下载HTML格式
4. 在报告查看页面的按钮栏添加"下载PDF"按钮

**需求关联**: FR-001 (在报告查看页面增加PDF下载按钮), FR-003 (转换失败处理机制)

**测试点**:
- 点击"下载PDF"按钮触发PDF下载流程
- 错误时显示友好错误提示
- 错误时可选择下载HTML格式

---

## 任务依赖关系

```
任务1 (安装依赖)
    ↓
任务2 (创建PDF服务) → 任务3 (添加API端点)
                              ↓
                        任务4 (前端样式)
                              ↓
                        任务5 (前端功能)
```

**执行顺序**: 任务1 → 任务2 → 任务3 → 任务4 → 任务5

---

## 文件变更清单

| 文件 | 操作 | 描述 |
|------|------|------|
| package.json | 修改 | 添加pdfkit依赖 |
| services/pdfService.js | 新建 | PDF转换服务模块 |
| routes/report.js | 修改 | 添加PDF下载API端点 |
| public/index.html | 修改 | 添加PDF按钮样式 |
| public/js/app.js | 修改 | 添加PDF下载函数和按钮 |

---

## 验收标准

完成所有任务后，系统应满足以下验收标准：

1. **FR-001**: 报告查看页面包含"下载PDF"按钮，点击后触发PDF下载流程
2. **FR-002**: 服务端能够将HTML报告内容完整转换为PDF格式
3. **FR-003**: 转换失败时返回友好的错误提示，不影响HTML下载功能
4. **FR-004**: API端点 `GET /api/report/:id/download/pdf` 返回application/pdf类型