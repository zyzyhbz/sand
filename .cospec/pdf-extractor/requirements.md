# 需求规格说明书 - PDF文本提取模块

## 1. 项目概述

### 1.1 背景

邮件安全检测系统已具备邮件接收/解析、附件检测、AI安全分析等功能模块。当前系统中，AI安全分析模块仅能接收编码后的PDF数据（如base64字符串），无法直接获取PDF文件中的文本内容，导致AI无法对PDF附件进行有效的文本级别安全分析（如钓鱼内容检测、恶意链接识别、社会工程学文本分析等）。

### 1.2 目标

开发一个PDF文本提取模块（pdf_extractor），实现以下业务目标：

- 从PDF附件中提取可读文本内容
- 将提取的文本以现有AI系统期望的格式传递，使AI能够进行文本级别的安全分析
- 支持多种PDF类型的文本提取（文本型PDF、扫描件/图片型PDF）
- 提供统一的输出格式，与现有邮件安全检测系统无缝集成

### 1.3 范围

**包含的内容：**

- PDF文本内容提取（文本型PDF）
- OCR文本提取（扫描件/图片型PDF）
- 提取结果格式化为AI系统可接收的结构
- 与现有AI分析系统的集成接口
- 提取过程中的错误处理与优雅降级
- 大文件分页处理机制
- 缓存机制（相同PDF避免重复提取）

**不包含的内容：**

- PDF表格结构化提取
- PDF图片提取
- PDF表单数据提取
- PDF数字签名验证
- PDF水印处理
- 非PDF格式文件的处理

## 2. 功能需求

### 2.1 用户角色

| 角色名称 | 描述 | 权限 |
|----------|------|------|
| 系统调用方 | 邮件安全检测系统的其他模块（如附件检测模块） | 调用PDF文本提取接口，获取提取结果 |
| AI分析模块 | 现有AI安全分析功能 | 接收格式化后的提取文本，执行安全分析 |

### 2.2 功能清单

#### 2.2.1 PDF文本提取核心功能

- **需求ID**: FR-001
- **需求描述**: 提供核心函数 `extract_pdf_content`，接收PDF原始数据（支持bytes或base64字符串），提取PDF中的文本内容，返回结构化的提取结果。
- **优先级**: 高
- **验收标准**:
  - 能正确接收bytes类型的PDF数据
  - 能正确接收base64编码的PDF字符串并解码后提取
  - 返回结果包含 success（是否成功）、text（提取的文本）、metadata（元数据）、page_count（页数）、used_ocr（是否使用了OCR）、error（错误信息）字段
  - 空PDF或无文本PDF返回 success=true，text为空字符串
- **依赖关系**: 无

**函数接口定义：**

```python
def extract_pdf_content(
    pdf_data: Union[bytes, str],       # PDF原始数据（支持bytes或base64字符串）
    use_ocr: bool = False,              # 是否启用OCR
    ocr_languages: List[str] = ["eng"], # OCR语言列表
    max_pages: int = 50,                # 最大处理页数
    config: Optional[Dict] = None       # 配置参数
) -> Dict[str, Any]
```

**返回格式：**

```python
{
    "success": bool,             # 提取是否成功
    "text": str,                 # 提取的文本内容
    "metadata": Dict,            # PDF元数据信息
    "page_count": int,           # PDF总页数
    "used_ocr": bool,            # 是否使用了OCR提取
    "error": Optional[str]       # 错误信息（成功时为None）
}
```

#### 2.2.2 多策略文本提取

- **需求ID**: FR-002
- **需求描述**: 支持多种PDF文本提取策略，按优先级自动选择和降级。首选pdfplumber，备选PyPDF2，当文本型提取结果为空或质量不足时，自动降级到OCR方式提取。
- **优先级**: 高
- **验收标准**:
  - 默认使用pdfplumber作为首选提取器
  - 当首选提取器失败或结果为空时，自动尝试备选提取器（PyPDF2）
  - 当所有文本型提取器均无法获取有效文本时，若配置允许OCR，自动切换到OCR提取
  - 提取结果中记录实际使用的提取方法（method_used字段）
  - 支持通过配置自定义提取器优先级顺序
- **依赖关系**: FR-001

**提取策略链：**

| 优先级 | 提取方法 | 适用场景 |
|--------|---------|---------|
| 1 | pdfplumber | 文本型PDF，支持表格布局 |
| 2 | PyPDF2 | 文本型PDF，兼容性较广 |
| 3 | OCR（pdf2image + pytesseract） | 扫描件/图片型PDF |

#### 2.2.3 OCR文本提取

- **需求ID**: FR-003
- **需求描述**: 对于扫描件或图片型PDF，通过OCR技术提取文本内容。支持配置OCR语言、DPI等参数。
- **优先级**: 中
- **验收标准**:
  - 能将PDF页面转换为图片后进行OCR识别
  - 支持多语言OCR识别（至少支持英文和简体中文）
  - OCR语言可通过参数 `ocr_languages` 配置
  - 可通过 `use_ocr` 参数强制启用或禁用OCR
  - 提取结果中 `used_ocr` 字段正确反映是否使用了OCR
- **依赖关系**: FR-001

#### 2.2.4 统一输出格式化

- **需求ID**: FR-004
- **需求描述**: 将提取结果格式化为统一的标准输出结构，包含提取文本、统计信息、质量指标和AI兼容性信息。
- **优先级**: 高
- **验收标准**:
  - 输出包含 status 字段，取值为 success / partial / error
  - 输出包含 data 字段，含 extracted_text（提取文本）、summary（前500字符摘要）、statistics（字数/页数/提取耗时/使用方法）、quality_indicators（扫描页检测/提取置信度/是否需人工审核）
  - 输出包含 compatibility 字段，含 ai_ready（是否可直接传递给AI）、format（格式版本标识）、truncated（文本是否被截断）
  - 当文本超过最大长度限制时，标记 truncated=true 并截断文本
- **依赖关系**: FR-001

**统一输出结构：**

```json
{
  "status": "success|partial|error",
  "data": {
    "extracted_text": "提取的完整文本内容",
    "summary": "前500字符摘要",
    "statistics": {
      "word_count": 1500,
      "page_count": 10,
      "extraction_time_ms": 1200,
      "method_used": "pypdf2|pdfplumber|ocr"
    },
    "quality_indicators": {
      "has_scanned_pages": false,
      "extraction_confidence": 0.95,
      "needs_human_review": false
    }
  },
  "compatibility": {
    "ai_ready": true,
    "format": "ai_analysis_v1",
    "truncated": false
  }
}
```

#### 2.2.5 AI系统集成接口

- **需求ID**: FR-005
- **需求描述**: 提供 `PDFToAIBridge` 类，作为PDF文本提取模块与现有AI安全分析系统的集成桥梁，将邮件附件中的PDF提取为文本后自动传递给AI进行分析。
- **优先级**: 高
- **验收标准**:
  - 提供 `PDFToAIBridge` 类，构造函数接收 ai_model（AI模型实例）和 config（配置参数）
  - 提供 `process_email_attachment` 异步方法，接收 email_id（邮件ID）和 attachment（邮件附件对象），返回 AnalysisResult（分析结果）
  - 传递给AI的数据结构符合现有AI系统期望的输入格式（type、format、content、metadata、timestamp字段）
  - metadata 中包含 filename、size、hash、extraction_method 信息
- **依赖关系**: FR-001, FR-004

**AI期望的输入结构：**

```python
{
    "type": "email_attachment",
    "format": "pdf",
    "content": "提取的文本内容",
    "metadata": {
        "filename": str,
        "size": int,
        "hash": str,
        "extraction_method": str
    },
    "timestamp": str
}
```

**集成接口定义：**

```python
class PDFToAIBridge:
    def __init__(self, ai_model, config=None):
        """
        初始化集成桥梁
        :param ai_model: AI模型实例
        :param config: 配置参数
        """
        self.ai = ai_model
        self.extractor = PDFTextExtractor(config)

    async def process_email_attachment(
        self,
        email_id: str,
        attachment: EmailAttachment
    ) -> AnalysisResult:
        """
        处理邮件PDF附件：提取文本并交由AI分析
        :param email_id: 邮件唯一标识
        :param attachment: 邮件附件对象
        :return: AI分析结果
        """
        pass
```

#### 2.2.6 错误处理与优雅降级

- **需求ID**: FR-006
- **需求描述**: 在PDF文件损坏、加密、内存不足、网络超时等异常场景下，提供优雅的错误处理和降级方案，确保系统不会因单个PDF处理失败而崩溃。
- **优先级**: 高
- **验收标准**:
  - PDF文件损坏时，返回 status=error，error字段包含具体错误描述，不抛出未捕获异常
  - PDF文件加密时，返回 status=error 并在error字段提示"PDF已加密，无法提取"
  - 大PDF文件处理时，自动启用分页处理，避免内存溢出
  - OCR服务超时时，返回已提取的部分结果（status=partial）并记录超时错误
  - 所有提取器均失败时，返回 status=error，包含最后一次失败的错误信息
- **依赖关系**: FR-001, FR-002

#### 2.2.7 大文件分页处理

- **需求ID**: FR-007
- **需求描述**: 对于大页数或大体积的PDF文件，支持分页/增量提取，避免一次性加载整个文件导致内存溢出。
- **优先级**: 中
- **验收标准**:
  - 通过 max_pages 参数限制最大处理页数（默认50页）
  - 超过最大页数时，提取前 max_pages 页内容，返回结果标记 truncated=true
  - 分页提取时，每页提取完成后立即释放该页资源
  - 支持流式读取PDF文件，减少内存占用
- **依赖关系**: FR-001

#### 2.2.8 缓存机制

- **需求ID**: FR-008
- **需求描述**: 对相同PDF文件的提取结果进行缓存，避免重复提取。以PDF文件的哈希值作为缓存键。
- **优先级**: 中
- **验收标准**:
  - 计算PDF数据的哈希值（如SHA256）作为缓存键
  - 相同哈希的PDF在缓存有效期内直接返回缓存结果
  - 可通过配置启用/禁用缓存（cache_results参数）
  - 缓存命中时，返回结果与首次提取结果一致
- **依赖关系**: FR-001

#### 2.2.9 并行提取处理

- **需求ID**: FR-009
- **需求描述**: 对多页PDF支持并行提取，提升大文件的提取速度。
- **优先级**: 低
- **验收标准**:
  - 可通过配置启用异步/并行处理（use_async参数）
  - 并行提取时，各页文本按页码顺序合并
  - 并行提取的结果与串行提取的结果一致
- **依赖关系**: FR-001, FR-007

#### 2.2.10 配置管理

- **需求ID**: FR-010
- **需求描述**: 提供可外部化的配置管理，允许通过配置文件或参数调整模块行为，包括提取器选择、OCR参数、性能参数、AI集成参数等。
- **优先级**: 中
- **验收标准**:
  - 支持通过构造函数传入配置Dict
  - 未提供的配置项使用合理的默认值
  - 配置项包含：primary_extractor（首选提取器）、fallback_extractors（备选提取器列表）、ocr相关参数（enabled/language/timeout/dpi）、performance参数（max_file_size_mb/max_pages/use_async/cache_results）、ai_integration参数（max_text_length/include_metadata/format_version）
- **依赖关系**: FR-001

**配置结构定义：**

```python
PDF_EXTRACTOR_CONFIG = {
    "primary_extractor": "pdfplumber",
    "fallback_extractors": ["pypdf2", "ocr"],
    "ocr": {
        "enabled": True,
        "language": ["eng", "chi_sim"],
        "timeout": 30,
        "dpi": 300
    },
    "performance": {
        "max_file_size_mb": 50,
        "max_pages": 100,
        "use_async": True,
        "cache_results": True
    },
    "ai_integration": {
        "max_text_length": 10000,
        "include_metadata": True,
        "format_version": "1.0"
    }
}
```

#### 2.2.11 模块结构

- **需求ID**: FR-011
- **需求描述**: 模块按照职责划分为清晰的文件结构，便于维护和扩展。
- **优先级**: 中
- **验收标准**:
  - 模块目录为 `pdf_extractor/`
  - 包含 `__init__.py`（模块初始化，导出公共接口）
  - 包含 `core.py`（主提取逻辑，PDFTextExtractor类）
  - 包含 `ocr_handler.py`（OCR处理逻辑）
  - 包含 `utils.py`（工具函数，如哈希计算、文本处理等）
  - 包含 `integrations.py`（与现有系统集成，PDFToAIBridge类）
- **依赖关系**: FR-001, FR-005

**目录结构：**

```
pdf_extractor/
├── __init__.py          # 模块初始化，导出公共接口
├── core.py              # 主提取逻辑（PDFTextExtractor类）
├── ocr_handler.py       # OCR处理逻辑
├── utils.py             # 工具函数（哈希计算、文本处理等）
└── integrations.py      # 与现有系统集成（PDFToAIBridge类）
```

## 3. 用户故事

### 3.1 邮件附件自动文本提取

**作为** 邮件安全检测系统
**我想要** 自动提取邮件中PDF附件的文本内容
**以便于** AI安全分析模块能够对PDF内容进行文本级别的安全检测

**验收条件**:

* 系统接收到PDF附件后，自动调用文本提取模块
* 提取成功后，文本内容以AI可接收的格式传递
* 提取失败时，系统记录错误日志并返回明确的错误信息，不影响其他附件的处理

### 3.2 扫描件PDF文本提取

**作为** 安全分析人员
**我想要** 系统能够提取扫描件/图片型PDF中的文本内容
**以便于** 即使PDF是非文本型的，AI也能分析其中的文字内容

**验收条件**:

* 当文本型提取无法获取有效内容时，系统自动尝试OCR提取
* OCR支持英文和简体中文
* OCR提取结果标记 used_ocr=true

### 3.3 大文件安全处理

**作为** 系统运维人员
**我想要** 大体积PDF文件不会导致系统内存溢出或崩溃
**以便于** 系统在处理任意大小的PDF附件时保持稳定

**验收条件**:

* 超过配置最大页数的PDF仅处理前N页
* 分页处理时逐页释放资源
* 超过配置最大文件大小的PDF返回明确的错误提示

### 3.4 AI系统无缝对接

**作为** AI安全分析模块
**我想要** 接收结构化的PDF文本内容（包含文本、元数据、时间戳）
**以便于** 直接进行安全分析，无需额外的数据转换

**验收条件**:

* 传递给AI的数据结构包含 type、format、content、metadata、timestamp 字段
* metadata 包含 filename、size、hash、extraction_method
* 文本内容超过最大长度时自动截断并标记 truncated=true

## 4. 数据需求

### 4.1 数据实体

- **PDF原始数据**: 邮件附件中的PDF文件内容，支持bytes或base64编码字符串格式
- **提取结果**: 包含文本内容、元数据、统计信息、质量指标的结构化数据
- **AI分析输入**: 符合AI系统期望格式的结构化数据，包含文本内容和附件元信息
- **缓存记录**: 以PDF哈希为键，提取结果为值的缓存数据

### 4.2 数据流

1. 邮件系统接收到带有PDF附件的邮件
2. 附件检测模块识别PDF附件，将PDF数据（bytes或base64）传递给PDF文本提取模块
3. PDF文本提取模块选择合适的提取策略（pdfplumber → PyPDF2 → OCR）
4. 提取的文本经过格式化处理后，通过 PDFToAIBridge 传递给AI安全分析模块
5. AI模块返回分析结果，整个流程完成

```
邮件附件(PDF) → extract_pdf_content → 统一输出格式化 → PDFToAIBridge → AI安全分析
                     ↓
              (缓存结果以PDF哈希为键)
```

## 5. 假设和依赖

### 5.1 假设

- 假设现有邮件安全检测系统已有成熟的邮件附件提取机制，能够获取PDF附件的原始数据
- 假设现有AI安全分析模块已有明确的输入格式规范，PDF文本提取模块的输出需符合该规范
- 假设大多数需要处理的PDF为文本型PDF，扫描件/图片型PDF为少数场景
- 假设运行环境可安装Python依赖包（PyPDF2、pdfplumber、pdf2image、pytesseract等）
- 假设OCR场景下，系统已安装Tesseract OCR引擎及对应语言包

### 5.2 依赖

- **现有AI分析模块**: PDF文本提取模块的输出格式依赖AI模块的输入规范，AI模块接口变更需同步更新本模块
- **Python环境**: 依赖Python 3.8+运行环境
- **第三方库**: 
  - PyPDF2（PDF文本提取）
  - pdfplumber（PDF文本提取，首选）
  - pdf2image（PDF转图片，OCR前置步骤）
  - pytesseract（OCR文字识别）
- **Tesseract OCR**: OCR功能依赖系统安装的Tesseract OCR引擎
- **EmailAttachment数据结构**: 集成接口依赖现有系统中 EmailAttachment 类的定义
- **AnalysisResult数据结构**: 集成接口依赖现有系统中 AnalysisResult 类的定义
