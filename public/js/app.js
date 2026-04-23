// 全局状态
let selectedFiles = [];
let uploadedFiles = [];
let sessionId = 'session-' + Date.now();
let currentReport = null;
let currentReportMeta = null; // 存储当前报告的元数据
let lastAnalysisResult = null;
let lastFileInfo = null;
let lastAiReport = null;
let lastResult = null; // 存储完整的分析结果,包含toolUsed

// ===== 认证相关 =====
const AUTH_TOKEN_KEY = 'auth_token';

/**
 * 获取存储在localStorage中的认证Token
 * @returns {string|null} Token字符串或null
 */
function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY);
}

/**
 * 获取带Authorization header的请求头对象
 * @param {Object} [existingHeaders={}] 已有的请求头
 * @returns {Object} 合并后的请求头
 */
function getAuthHeaders(existingHeaders = {}) {
    const token = getAuthToken();
    if (token) {
        return { ...existingHeaders, 'Authorization': `Bearer ${token}` };
    }
    return existingHeaders;
}

/**
 * 带认证的fetch封装，自动附加Authorization header并处理401响应
 * @param {string} url 请求URL
 * @param {Object} [options={}] fetch选项
 * @returns {Promise<Response>} fetch响应
 */
async function authFetch(url, options = {}) {
    const token = getAuthToken();
    if (token) {
        options.headers = {
            ...options.headers,
            'Authorization': `Bearer ${token}`
        };
    }
    const response = await fetch(url, options);
    if (response.status === 401) {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        window.location.href = '/login';
        throw new Error('认证已过期，请重新登录');
    }
    return response;
}

/**
 * 退出登录，清除Token并跳转到登录页
 */
function handleLogout() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    window.location.href = '/login';
}

/**
 * 注销账号 - 删除当前用户账号及所有关联数据
 */
async function handleDeleteAccount() {
    // 二次确认
    const confirmed = confirm('确定要注销账号吗？此操作不可恢复，将删除您的所有报告和上传文件。');
    if (!confirmed) return;

    // 三次确认，输入用户名确认
    const username = document.getElementById('usernameDisplay').textContent;
    const input = prompt(`请输入用户名 "${username}" 以确认注销：`);
    if (input !== username) {
        if (input !== null) {
            alert('输入的用户名不匹配，已取消注销。');
        }
        return;
    }

    try {
        const response = await authFetch('/api/auth/account', {
            method: 'DELETE'
        });

        if (response.ok) {
            alert('账号已成功注销');
            localStorage.removeItem(AUTH_TOKEN_KEY);
            window.location.href = '/login';
        } else {
            const data = await response.json();
            alert(data.error || '注销账号失败，请稍后再试');
        }
    } catch (error) {
        console.error('注销账号失败:', error);
        alert('注销账号失败，请稍后再试');
    }
}

// DOM元素
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const selectedFilesList = document.getElementById('selectedFiles');
const analyzeBtn = document.getElementById('analyzeBtn');
const clearBtn = document.getElementById('clearBtn');
const chatContainer = document.getElementById('chatContainer');
const chatInput = document.getElementById('chatInput');
const reportList = document.getElementById('reportList');
const reportViewer = document.getElementById('reportViewer');
const reportBody = document.getElementById('reportBody');
const aiStatusPanel = document.getElementById('aiStatusPanel');
const aiStatusTitle = document.getElementById('aiStatusTitle');
const aiStatusMessage = document.getElementById('aiStatusMessage');
const aiStatusProgressBar = document.getElementById('aiStatusProgressBar');
const aiStatusSpinner = document.getElementById('aiStatusSpinner');

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 检查认证状态 - 主页面需要有效Token
    const token = getAuthToken();
    if (!token) {
        window.location.href = '/login';
        return;
    }

    // 验证Token有效性
    try {
        const response = await fetch('/api/auth/verify', {
            headers: getAuthHeaders()
        });
        if (response.ok) {
            const data = await response.json();
            // 显示用户信息
            const userInfo = document.getElementById('userInfo');
            const usernameDisplay = document.getElementById('usernameDisplay');
            const logoutBtn = document.getElementById('logoutBtn');
            const deleteAccountBtn = document.getElementById('deleteAccountBtn');
            if (userInfo && usernameDisplay && data.user) {
                usernameDisplay.textContent = data.user.username;
                userInfo.style.display = '';
                logoutBtn.style.display = '';
                deleteAccountBtn.style.display = '';
            }
        } else {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            window.location.href = '/login';
            return;
        }
    } catch (error) {
        console.error('Token验证失败:', error);
        window.location.href = '/login';
        return;
    }

    setupFileDrop();
    setupEventListeners();
    loadReports();
});

// 设置文件拖放
function setupFileDrop() {
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        handleFiles(files);
    });

    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        handleFiles(files);
    });
}

// 设置事件监听器
function setupEventListeners() {
    analyzeBtn.addEventListener('click', analyzeFiles);
    clearBtn.addEventListener('click', clearFiles);
    document.getElementById('refreshReports').addEventListener('click', loadReports);
}

// 处理文件
function handleFiles(files) {
    selectedFiles = [...selectedFiles, ...files];
    updateFileList();
    analyzeBtn.disabled = selectedFiles.length === 0;
}

// 更新文件列表
function updateFileList() {
    if (selectedFiles.length > 0) {
        fileList.style.display = 'block';
        selectedFilesList.innerHTML = selectedFiles.map((file, index) => `
            <div class="file-item">
                <div class="file-item-info">
                    <div class="file-item-icon">
                        <i class="bi bi-file-earmark"></i>
                    </div>
                    <span class="file-item-name">${file.name}</span>
                </div>
                <button class="btn-pill btn-danger-modern" style="padding: 0.375rem 0.75rem; font-size: 0.8rem;" onclick="removeFile(${index})">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `).join('');
    } else {
        fileList.style.display = 'none';
    }
}

// 移除文件
function removeFile(index) {
    selectedFiles.splice(index, 1);
    updateFileList();
    analyzeBtn.disabled = selectedFiles.length === 0;
}

// 清除文件
function clearFiles() {
    selectedFiles = [];
    uploadedFiles = [];
    updateFileList();
    analyzeBtn.disabled = true;
    fileInput.value = '';
}

// 上传文件
async function uploadFiles() {
    const formData = new FormData();
    selectedFiles.forEach(file => {
        formData.append('files', file);
    });

    try {
        const response = await authFetch('/api/upload/multiple', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (data.success) {
            uploadedFiles = data.files;
            return uploadedFiles;
        } else {
            throw new Error(data.error || '上传失败');
        }
    } catch (error) {
        console.error('上传失败:', error);
        throw error;
    }
}

// 分析文件
async function analyzeFiles() {
    if (selectedFiles.length === 0) return;

    try {
        // 禁用按钮
        analyzeBtn.disabled = true;
        clearBtn.disabled = true;

        // 上传文件
        addChatMessage('user', `正在上传 ${selectedFiles.length} 个文件...`);
        uploadedFiles = await uploadFiles();
        addChatMessage('ai', `✅ 文件上传成功！开始安全分析...`);

        // 分析每个文件（报告现在由后端自动生成）
        for (const file of uploadedFiles) {
            await analyzeSingleFile(file);
            // 注意：报告已在后端自动生成（routes/sandbox.js 中 generateReport = true）
        }

        // 启用按钮
        analyzeBtn.disabled = false;
        clearBtn.disabled = false;

        // 添加AI建议
        addChatMessage('ai', `📊 分析完成！我已经为所有 ${uploadedFiles.length} 个文件生成了详细的检测报告。如果您对结果有任何疑问，请随时询问。`);

        // 自动刷新报告列表
        console.log('[analyzeFiles] 调用 loadReports() 刷新报告列表...');
        await loadReports();
        console.log('[analyzeFiles] loadReports() 调用完成');

    } catch (error) {
        console.error('分析失败:', error);
        addChatMessage('ai', `❌ 分析失败: ${error.message}`);
        analyzeBtn.disabled = false;
        clearBtn.disabled = false;
    }
}

// 分析单个文件
async function analyzeSingleFile(file) {
    try {
        addChatMessage('user', `分析文件: ${file.filename}`);

        const response = await authFetch('/api/sandbox/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filePath: file.path,
                fileType: getFileType(file.filename)
                // 注意：后端现在默认自动生成报告（generateReport = true）
            })
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || '分析失败');
        }

        // 【新功能】后端生成报告后立即刷新报告列表
        // 这样用户在终端看到"报告已生成"后，侧边栏会立即显示新报告
        if (data.reportId) {
            console.log('[analyzeSingleFile] 检测到后端已生成报告,立即刷新报告列表...');
            await loadReports();
            console.log('[analyzeSingleFile] 报告列表刷新完成');
        }

        // 新架构:后端直接返回分析结果,不再嵌套在result字段中
        // 将整个data作为result对象传递(因为data本身就是分析结果)
        const result = data;

        // 安全显示分析结果（内部再做空值保护）- 已移除分析结果面板，仅在控制台输出
        console.log('[分析结果]', result);

        // 记录最近一次分析结果和文件信息，用于生成报告
        lastAnalysisResult = result.analysis || null;
        lastFileInfo = {
            filename: file.filename,
            originalName: file.originalname,  // 保存原始文件名用于报告命名
            size: file.size,
            mimetype: file.mimetype
        };
        lastResult = result; // 保存完整结果,包含toolUsed
        // 移除 lastAiReport = null; 这行，避免在调用 sendAnalysisToAI 之前重置AI报告数据

        // 将分析结果发送给AI（包含完整文件内容）
        // 【重要修复】必须await等待AI分析完成,确保lastAiReport已保存
        // 否则用户可能在AI分析完成前就点击生成报告,导致aiReport为null
        console.log('[analyzeSingleFile] 开始等待AI分析完成...');
        try {
            await sendAnalysisToAI(result);
            console.log('[analyzeSingleFile] AI分析已完成, lastAiReport已保存');
        } catch (error) {
            console.error('[analyzeSingleFile] AI分析失败, 设置默认AI报告:', error);
            // 【关键修复】当AI分析失败时,设置lastAiReport为错误信息
            // 这样即使AI失败,自动报告更新逻辑也能执行,用户会看到错误信息而不是空报告
            lastAiReport = `AI分析失败: ${error.message}\n\n详细错误: ${error}`;
            console.log('[analyzeSingleFile] lastAiReport已设置为错误信息');
        }

        // 【新功能】AI分析完成后自动更新报告中的AI数据
        // 后端sandbox.js已经自动生成了基础报告(aiReport=null)
        // 现在我们在前端AI分析完成后,调用新路由更新报告的aiReport字段
        if (data.reportId && lastAiReport) {
            console.log('[analyzeSingleFile] 开始更新报告AI数据, reportId:', data.reportId);
            try {
                const updateResponse = await authFetch('/api/sandbox/update-report-ai', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        reportId: data.reportId,
                        aiReport: lastAiReport
                    })
                });

                const updateData = await updateResponse.json();
                if (updateData.success) {
                    console.log('[analyzeSingleFile] 报告AI数据更新成功');
                    console.log('[analyzeSingleFile] AI报告长度:', updateData.aiReportLength);
                    if (updateData.riskLevel) {
                        console.log('[analyzeSingleFile] AI风险评级已更新:', updateData.riskLevel);
                    }
                    // AI更新后刷新报告列表，使侧边栏显示AI结论的风险等级
                    await loadReports();
                } else {
                    console.error('[analyzeSingleFile] 报告AI数据更新失败:', updateData.error);
                }
            } catch (error) {
                console.error('[analyzeSingleFile] 更新报告AI数据失败:', error);
                // 不阻断流程,因为基础报告已经生成,只是AI数据可能为空
            }
        } else {
            console.log('[analyzeSingleFile] 跳过报告AI更新, reportId:', data.reportId, ', lastAiReport存在:', !!lastAiReport);
        }

    } catch (error) {
        console.error('文件分析失败:', error);
        addChatMessage('ai', `❌ 文件 ${file.filename} 分析失败: ${error.message}`);

    }
}

// 获取文件类型
function getFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const types = {
        js: 'js',
        html: 'html',
        htm: 'html',
        pdf: 'pdf',
        doc: 'doc',
        docx: 'doc',
        xls: 'xls',
        xlsx: 'xls',
        eml: 'email',
        msg: 'email'
    };
    return types[ext] || 'auto';
}

// 发送分析结果到AI
async function sendAnalysisToAI(result) {
    try {
        // 构建详细的分析提示，包含文件内容和结构信息
        const toolName = result.toolUsed || '文件读取器';
        const fileName = result.filePath.split('/').pop();
        let detailedPrompt = `请对以下文件进行专业的安全评估分析：

【文件信息】
- 文件名: ${fileName}
- 文件路径: ${result.filePath}
- 文件类型: ${result.fileType || '未知'}
- 使用工具: ${toolName}
- 时间: ${result.timestamp || new Date().toISOString()}
`;

        // 【关键】添加文件内容 - 这是AI分析的核心数据
        if (result.analysis?.fullContent) {
            detailedPrompt += `
【EML邮件完整内容】
${result.analysis.fullContent}
`;
        } else if (result.analysis?.fileContent) {
            detailedPrompt += `
【文本文件内容】
${result.analysis.fileContent}
`;
        } else if (result.analysis?.decompiledContent) {
            // 新增: 支持Decompiler反编译的可执行文件内容
            detailedPrompt += `
【可执行文件反编译结果】
${result.analysis.decompiledContent}
`;
        } else if (result.analysis?.headerInfo) {
            detailedPrompt += `
【二进制文件头部(HEX)】
${result.analysis.headerInfo}
`;
        }

        // 添加EML邮件结构信息(如果有)
        if (result.analysis?.emailInfo) {
            detailedPrompt += `
【EML邮件结构信息】
- 发件人: ${result.analysis.emailInfo.from || '未知'}
- 收件人: ${result.analysis.emailInfo.to || '未知'}
- 主题: ${result.analysis.emailInfo.subject || '未知'}
- 日期: ${result.analysis.emailInfo.date || '未知'}
- URL数量: ${result.analysis.emailInfo.urlsFound?.length || 0}
- 附件数量: ${result.analysis.emailInfo.attachments?.length || 0}
`;

            // 添加附件信息
            if (result.analysis.emailInfo.attachments && result.analysis.emailInfo.attachments.length > 0) {
                detailedPrompt += `附件列表:
`;
                result.analysis.emailInfo.attachments.forEach((att, index) => {
                    detailedPrompt += `${index + 1}. ${att.filename} (${att.contentType}, ${att.size} bytes)
`;
                });
            }

            // 添加安全标志
            if (result.analysis.emailInfo.securityFlags && result.analysis.emailInfo.securityFlags.length > 0) {
                detailedPrompt += `安全警告:
`;
                result.analysis.emailInfo.securityFlags.forEach((flag, index) => {
                    detailedPrompt += `- ${flag}
`;
                });
            }
        }

        // 添加文件大小信息(如果有)
        if (result.analysis?.fileSize) {
            detailedPrompt += `
【文件大小信息】
${result.analysis.fileSize} bytes
`;
        }

        // 添加URL信息(如果有)
        if (result.analysis?.urlsFound && result.analysis.urlsFound.length > 0) {
            detailedPrompt += `
【检测到的URL】
`;
            result.analysis.urlsFound.forEach((url, index) => {
                detailedPrompt += `${index + 1}. ${url}
`;
            });
        }

        // 添加Quickmu完整分析结果(如果有)
        if (result.analysis?.quickmuAnalysis) {
            const quickmu = result.analysis.quickmuAnalysis;
            detailedPrompt += `
【Quickmu可执行文件详细分析】
`;

            // 摘要信息
            if (quickmu.summary) {
                detailedPrompt += `分析摘要: ${quickmu.summary}
`;
            }

            // 文件信息
            if (quickmu.details?.fileInfo) {
                const fi = quickmu.details.fileInfo;
                detailedPrompt += `
- 文件名: ${fi.filename}
- 文件大小: ${fi.size} bytes
- 文件哈希: ${fi.hash}
- 文件类型: ${fi.extension}
`;
            }

            // 基本信息
            if (quickmu.details?.basicInfo) {
                const bi = quickmu.details.basicInfo;
                detailedPrompt += `
基本分析:
- 熵值: ${bi.entropy}
- 文件类型: ${bi.fileType}
`;
                if (bi.signatures && bi.signatures.length > 0) {
                    detailedPrompt += `- 检测到的签名: ${bi.signatures.map(s => s.name).join(', ')}
`;
                }
                if (bi.packerInfo) {
                    detailedPrompt += `- 是否加壳: ${bi.packerInfo.isPacked ? '是' : '否'} (${bi.packerInfo.packerName || '未知'})
`;
                }
                if (bi.digitalSignature) {
                    detailedPrompt += `- 数字签名状态: ${bi.digitalSignature.Status === 0 ? '已签名' : '未签名'}
`;
                }
            }

            // 静态分析
            if (quickmu.details?.staticAnalysis) {
                const sa = quickmu.details.staticAnalysis;
                detailedPrompt += `
静态分析:
`;
                if (sa.sections && sa.sections.length > 0) {
                    detailedPrompt += `- 节区信息: ${sa.sections.map(s => `${s.name}(${s.suspicious ? '可疑' : '正常'})`).join(', ')}
`;
                }
                if (sa.imports && sa.imports.length > 0) {
                    detailedPrompt += `- 导入函数: ${sa.imports.slice(0, 10).join(', ')}${sa.imports.length > 10 ? ` (共${sa.imports.length}个)` : ''}
`;
                }
                if (sa.exports && sa.exports.length > 0) {
                    detailedPrompt += `- 导出函数: ${sa.exports.slice(0, 10).join(', ')}${sa.exports.length > 10 ? ` (共${sa.exports.length}个)` : ''}
`;
                }
                if (sa.strings && sa.strings.length > 0) {
                    detailedPrompt += `- 重要字符串(前20个): ${sa.strings.slice(0, 20).map(s => `"${s}"`).join(', ')}...
`;
                }
            }

            // 威胁检测
            if (quickmu.details?.threatDetection) {
                const td = quickmu.details.threatDetection;
                detailedPrompt += `
威胁检测:
`;
                if (td.threats && td.threats.length > 0) {
                    td.threats.forEach((threat, idx) => {
                        detailedPrompt += `${idx + 1}. ${threat.severity}: ${threat.message}
`;
                    });
                } else {
                    detailedPrompt += `- 未检测到明显威胁
`;
                }
            }

            // 风险评估
            if (quickmu.details?.riskAssessment) {
                const ra = quickmu.details.riskAssessment;
                detailedPrompt += `
风险评估:
- 总分: ${ra.score}
- 风险等级: ${ra.level}
- 裁决: ${ra.verdict}
`;
            }
        }

        // 添加结构信息(如果有)
        if (result.analysis?.structureInfo) {
            detailedPrompt += `
【结构分析结果】
${JSON.stringify(result.analysis.structureInfo, null, 2)}
`;
        }

        // 保留向后兼容性:如果存在旧格式的分析数据,也要加入
        if (result.analysis?.maliciousBehavior && result.analysis.maliciousBehavior.length > 0) {
            detailedPrompt += `
【检测到的恶意行为】
`;
            result.analysis.maliciousBehavior.forEach((behavior, index) => {
                detailedPrompt += `${index + 1}. ${behavior.type || '恶意行为'}: ${JSON.stringify(behavior.details || behavior)}
`;
            });
        }

        if (result.analysis?.networkActivity && result.analysis.networkActivity.length > 0) {
            detailedPrompt += `
【网络活动分析】
`;
            result.analysis.networkActivity.forEach((activity, index) => {
                detailedPrompt += `${index + 1}. ${activity.type || '网络活动'}: ${JSON.stringify(activity.details || activity)}
`;
            });
        }

        if (result.analysis?.fileOperations && result.analysis.fileOperations.length > 0) {
            detailedPrompt += `
【文件系统操作】
`;
            result.analysis.fileOperations.forEach((operation, index) => {
                detailedPrompt += `${index + 1}. ${operation.type || '文件操作'}: ${JSON.stringify(operation.details || operation)}
`;
            });
        }

        if (result.analysis?.urls && result.analysis.urls.length > 0) {
            detailedPrompt += `
【检测到的URL】
`;
            result.analysis.urls.forEach((url, index) => {
                detailedPrompt += `${index + 1}. ${url}
`;
            });
        }

        if (result.analysis?.suspiciousPatterns && result.analysis.suspiciousPatterns.length > 0) {
            detailedPrompt += `
【发现的可疑模式】
`;
            result.analysis.suspiciousPatterns.forEach((pattern, index) => {
                detailedPrompt += `${index + 1}. ${pattern}
`;
            });
        }

        // 添加工具执行输出(向后兼容)
        if (result.stdout) {
            detailedPrompt += `
【工具执行输出】
${result.stdout}
`;
        }

        if (result.stderr) {
            detailedPrompt += `
【工具错误输出】
${result.stderr}
`;
        }

        detailedPrompt += `
【分析要求】
基于以上文件内容和结构信息,请提供:
1. 综合威胁评估和风险等级(高/中/低)
2. 具体的恶意行为或可疑特征分析
3. 网络安全风险评估(URL安全性分析)
4. 文件系统影响分析
5. 详细的安全建议和防护措施
6. 如果是误报的可能性分析

请直接分析文件内容,识别潜在的威胁和恶意模式。用专业、详细的中文进行分析。`;

        try {
            const response = await authFetch('/api/ai/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: detailedPrompt,
                    sessionId: sessionId,
                    context: {
                        analyResults: result.analysis,
                        fileInfo: {
                            filename: result.filePath.split('/').pop(),
                            size: result.filePath.length,
                            mimetype: result.mimetype || 'unknown',
                            fullPath: result.filePath
                        },
                        toolUsed: result.toolUsed || '分析工具',
                        sandboxOutput: {
                            stdout: result.stdout || '',
                            stderr: result.stderr || ''
                        }
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            // 显示正在输入
            const typingIndicator = document.createElement('div');
            typingIndicator.className = 'chat-message ai';
            typingIndicator.innerHTML = `
        <div class="typing-indicator">
            <span></span><span></span><span></span>
        </div>
    `;
            chatContainer.appendChild(typingIndicator);
            chatContainer.scrollTop = chatContainer.scrollHeight;

            let aiMessage = '';
            let timeoutId;
            const streamTimeout = 30000; // 30秒超时

            function resetTimeout() {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => {
                    console.warn('AI响应超时，停止接收数据');
                    if (chatContainer.contains(typingIndicator)) {
                        chatContainer.removeChild(typingIndicator);
                    }
                    addChatMessage('ai', aiMessage + '\n\n[响应超时，内容可能不完整]');
                    // 【关键】超时时设置lastAiReport
                    lastAiReport = aiMessage + '\n\n[AI响应超时,请重试]';
                }, streamTimeout);
            }

            // 将流式读取包装在Promise中以便await
            await new Promise((resolve, reject) => {
                function readStream() {
                    resetTimeout();

                    reader.read().then(({ done, value }) => {
                        clearTimeout(timeoutId);

                        if (done) {
                            if (chatContainer.contains(typingIndicator)) {
                                chatContainer.removeChild(typingIndicator);
                            }

                            // 【关键】AI响应接收完成后，进行格式美化
                            console.log('[sendAnalysisToAI] AI响应接收完成，原始内容长度:', aiMessage.length);
                            const formattedMessage = formatAIReport(aiMessage);
                            console.log('[sendAnalysisToAI] 格式美化完成，新内容长度:', formattedMessage.length);

                            addChatMessage('ai', formattedMessage);
                            // 保存格式美化后的AI报告内容供generateReport使用
                            lastAiReport = formattedMessage;
                            console.log('[sendAnalysisToAI] 格式美化后的AI报告已保存到lastAiReport');
                            resolve();
                            return;
                        }

                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n');

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') continue;

                                try {
                                    const json = JSON.parse(data);
                                    if (json.content) {
                                        aiMessage += json.content;
                                    }
                                } catch (e) {
                                    console.error('解析AI响应数据错误:', e);
                                }
                            }
                        }

                        readStream();
                    }).catch(error => {
                        console.error('读取AI响应流错误:', error);
                        clearTimeout(timeoutId);
                        if (chatContainer.contains(typingIndicator)) {
                            chatContainer.removeChild(typingIndicator);
                        }
                        addChatMessage('ai', aiMessage + '\n\n[连接中断，响应可能不完整]');
                        // 【关键】流读取错误时设置lastAiReport
                        lastAiReport = aiMessage + '\n\n[AI连接中断,分析不完整]';
                        // 在这里reject可以触发外层catch,但不要中断流程
                        reject(error);
                    });
                }

                readStream();
            });

        } catch (error) {
            // 【关键】fetch失败或其他错误时设置lastAiReport
            console.error('[sendAnalysisToAI] AI分析失败,设置错误信息:', error);
            lastAiReport = `AI分析失败: ${error.message}`;
            // 重新抛出错误,让analyzeSingleFile的catch能捕获
            throw error;
        }

    } catch (error) {
        console.error('AI分析失败:', error);
    }
}

/**
 * 美化AI报告格式
 * 在接收完AI完整响应后调用，对内容进行格式优化
 * @param {string} content - 原始AI报告内容
 * @returns {string} - 美化后的内容
 */
function formatAIReport(content) {
    if (!content || typeof content !== 'string') {
        return content;
    }

    console.log('[formatAIReport] 开始格式化AI报告，原始长度:', content.length);

    let formatted = content;

    // 1. 清理多余的空行（超过2个连续空行合并为2个）
    formatted = formatted.replace(/\n{3,}/g, '\n\n');

    // 2. 统一标题格式
    // 将 "# 标题" 或 "## 标题" 等转换为统一的HTML样式
    formatted = formatted.replace(/^(#{1,6})\s*(.+)$/gm, (match, hashes, title) => {
        const level = hashes.length;
        const className = `report-h${level}`;
        return `<h${level} class="${className}">${title.trim()}</h${level}>`;
    });

    // 3. 美化列表显示 - 统一列表项格式
    formatted = formatted.replace(/^[\s]*[-*•]\s+(.+)$/gm, '<li class="report-list-item">$1</li>');

    // 4. 美化数字列表
    formatted = formatted.replace(/^[\s]*(\d+)\.\s+(.+)$/gm, '<li class="report-list-item" data-index="$1">$2</li>');

    // 5. 高亮风险等级关键词
    const riskPatterns = [
        { pattern: /(高风险|高危|严重|Critical|High Risk)/gi, class: 'risk-high' },
        { pattern: /(中风险|中危|警告|Medium|Warning)/gi, class: 'risk-medium' },
        { pattern: /(低风险|低危|信息|Low|Info)/gi, class: 'risk-low' },
        { pattern: /(安全|正常|通过|Safe|Clean)/gi, class: 'risk-safe' }
    ];

    riskPatterns.forEach(({ pattern, class: className }) => {
        formatted = formatted.replace(pattern, (match) => {
            return `<span class="${className}">${match}</span>`;
        });
    });

    // 6. 美化代码块
    formatted = formatted.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre class="report-code-block"><code class="language-${lang || 'text'}">${code.trim()}</code></pre>`;
    });

    // 7. 美化行内代码
    formatted = formatted.replace(/`([^`]+)`/g, '<code class="report-inline-code">$1</code>');

    // 8. 美化引用块
    formatted = formatted.replace(/^[\s]*>\s*(.+)$/gm, '<blockquote class="report-quote">$1</blockquote>');

    // 9. 美化分隔线
    formatted = formatted.replace(/^[\s]*[-=]{3,}[\s]*$/gm, '<hr class="report-divider">');

    // 10. 为表格添加样式（如果存在Markdown表格）
    formatted = formatted.replace(/\|(.+)\|\n\|[-\s|]+\|\n((?:\|.+)\|)/g, (match, header, rows) => {
        const headers = header.split('|').map(h => h.trim()).filter(h => h);
        const rowData = rows.split('\n').map(row => {
            const cells = row.split('|').map(c => c.trim()).filter(c => c);
            return cells;
        });

        let tableHtml = '<table class="report-table"><thead><tr>';
        headers.forEach(h => {
            tableHtml += `<th>${h}</th>`;
        });
        tableHtml += '</tr></thead><tbody>';

        rowData.forEach(row => {
            tableHtml += '<tr>';
            row.forEach(cell => {
                tableHtml += `<td>${cell}</td>`;
            });
            tableHtml += '</tr>';
        });

        tableHtml += '</tbody></table>';
        return tableHtml;
    });

    // 11. 美化链接
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="report-link" target="_blank">$1</a>');

    // 12. 为纯文本段落添加样式（如果不在HTML标签内）
    // 先分割成行，处理每行
    const lines = formatted.split('\n');
    const processedLines = [];
    let inHtmlBlock = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 检查是否在HTML块内
        if (line.startsWith('<') && !line.startsWith('</')) {
            inHtmlBlock = true;
        }
        if (line.endsWith('/>') || line.endsWith('</')) {
            inHtmlBlock = false;
        }
        if (line.startsWith('</')) {
            inHtmlBlock = false;
        }

        // 如果是纯文本且不在HTML块内，包装在段落标签中
        if (line && !line.startsWith('<') && !inHtmlBlock) {
            processedLines.push(`<p class="report-paragraph">${line}</p>`);
        } else {
            processedLines.push(lines[i]);
        }
    }

    formatted = processedLines.join('\n');

    console.log('[formatAIReport] 格式化完成，新长度:', formatted.length);
    return formatted;
}

// 显示AI状态
function showAIStatus(title, message, progress = 0) {
    aiStatusTitle.textContent = title;
    aiStatusMessage.textContent = message;
    aiStatusProgressBar.style.width = progress + '%';
    aiStatusPanel.style.display = 'block';
}

// 隐藏AI状态
function hideAIStatus() {
    aiStatusPanel.style.display = 'none';
}

// 更新AI状态进度
function updateAIStatusProgress(progress, message) {
    aiStatusProgressBar.style.width = progress + '%';
    if (message) {
        aiStatusMessage.textContent = message;
    }
}

// 生成报告
async function generateReport() {
    try {
        // 【关键】详细日志追踪: 检查lastAiReport状态
        console.log('[generateReport] ===== 开始生成报告 =====');
        console.log('[generateReport] lastAiReport 类型:', typeof lastAiReport);
        console.log('[generateReport] lastAiReport 是否为null/undefined:', lastAiReport === null || lastAiReport === undefined);
        console.log('[generateReport] lastAiReport 长度:', lastAiReport ? lastAiReport.length : 'N/A');
        console.log('[generateReport] lastAiReport 前200字符:', lastAiReport ? lastAiReport.substring(0, 200) : '无内容');

        if (!lastResult || !lastFileInfo) {
            console.error('暂无可用的分析结果，无法生成报告');
            return;
        }

        // 【方案2】如果AI分析尚未完成，先调用AI服务生成报告
        if (!lastAiReport) {
            console.log('[generateReport] AI报告为null，开始调用AI服务生成...');
            showAIStatus('正在生成AI分析报告...', 'AI正在分析文件内容，请稍候...', 10);

            try {
                // 调用sendAnalysisToAI生成AI报告
                await sendAnalysisToAI(lastResult);
                console.log('[generateReport] AI服务调用完成，lastAiReport长度:', lastAiReport ? lastAiReport.length : 0);
            } catch (aiError) {
                console.error('[generateReport] AI服务调用失败:', aiError);
                // 如果AI调用失败，使用错误信息作为AI报告
                lastAiReport = `AI分析报告生成失败: ${aiError.message}\n\n请稍后重试或联系管理员。`;
            }
        }

        // 显示AI报告生成状态
        showAIStatus('AI正在生成报告...', '正在分析文件内容，请稍候...', 10);

        // 【重要】传递完整的数据结构,与对话框AI一致
        // 使用完整的lastResult对象,包含fullContent、emailInfo等所有数据
        const requestData = {
            // 完整的分析结果对象(与sendAnalysisToAI发送的一样)
            analysisData: lastResult.analysis || lastResult,
            fileInfo: lastFileInfo,
            toolUsed: lastResult.toolUsed || '分析工具',
            aiReport: lastAiReport  // 使用保存的AI响应
        };

        console.log('[generateReport] 发送到后端的完整数据:', JSON.stringify({
            analysisData: typeof requestData.analysisData,
            fileInfo: typeof requestData.fileInfo,
            toolUsed: requestData.toolUsed,
            aiReport: typeof requestData.aiReport,
            aiReportLength: requestData.aiReport ? requestData.aiReport.length : 0
        }, null, 2));
        console.log('[generateReport] AI报告完整内容:', lastAiReport ? lastAiReport : '无内容');

        const response = await authFetch('/api/report/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestData)
        });

        updateAIStatusProgress(50, '正在生成详细分析报告...');

        const data = await response.json();
        if (data.success) {
            currentReport = data.report;
            updateAIStatusProgress(80, '报告生成完成，正在准备显示...');
            setTimeout(() => {
                updateAIStatusProgress(100, '报告生成完成！');
                setTimeout(hideAIStatus, 2000);
                // 报告生成完成后自动刷新报告列表
                loadReports();
            }, 500);
        } else {
            hideAIStatus();
            console.error('报告生成失败:', data.error);
        }
    } catch (error) {
        hideAIStatus();
        console.error('报告生成失败:', error);
    }
}

// 发送消息
async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message) return;

    chatInput.value = '';
    addChatMessage('user', message);

    try {
        const response = await authFetch('/api/ai/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: message,
                sessionId: sessionId
            })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        // 显示正在输入
        const typingIndicator = document.createElement('div');
        typingIndicator.className = 'chat-message ai';
        typingIndicator.innerHTML = `
    <div class="typing-indicator">
        <span></span><span></span><span></span>
    </div>
`;
        chatContainer.appendChild(typingIndicator);
        chatContainer.scrollTop = chatContainer.scrollHeight;

        let aiMessage = '';

        function readStream() {
            reader.read().then(({ done, value }) => {
                if (done) {
                    chatContainer.removeChild(typingIndicator);
                    addChatMessage('ai', aiMessage);
                    return;
                }

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const json = JSON.parse(data);
                            if (json.content) {
                                aiMessage += json.content;
                            }
                        } catch (e) { }
                    }
                }

                readStream();
            });
        }

        readStream();

    } catch (error) {
        console.error('发送消息失败:', error);
        addChatMessage('ai', `❌ 发送失败: ${error.message}`);
    }
}

// 添加聊天消息
function addChatMessage(role, message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    messageDiv.innerHTML = `
<div class="chat-bubble">${message.replace(/\n/g, '<br>')}</div>
`;
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// 加载报告列表
async function loadReports() {
    try {
        const response = await authFetch('/api/report/list');
        const data = await response.json();
        if (!response.ok || data.error) {
            // 后端返回错误时（如新用户无报告），显示暂无报告
            reportList.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><p>暂无报告</p></div>';
        } else if (data.reports && data.reports.length === 0) {
            reportList.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><p>暂无报告</p></div>';
        } else if (data.reports) {
            reportList.innerHTML = data.reports.map(report => {
                // 对reportId进行URL编码,确保包含空格等特殊字符时不会被破坏
                const encodedReportId = encodeURIComponent(report.id);
                // 使用displayId显示原始文件名，如果没有则使用id
                const displayId = report.displayId || report.id;
                // 生成文件类型图标
                const fileExt = displayId.split('.').pop().toLowerCase();
                let icon = 'bi-file-earmark';
                if (['exe', 'dll', 'bat', 'cmd'].includes(fileExt)) icon = 'bi-file-earmark-play';
                else if (['js', 'ts', 'py', 'java', 'c', 'cpp'].includes(fileExt)) icon = 'bi-file-earmark-code';
                else if (['eml', 'msg', 'mime'].includes(fileExt)) icon = 'bi-envelope';
                else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(fileExt)) icon = 'bi-file-earmark-zip';
                else if (['pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(fileExt)) icon = 'bi-file-earmark-text';

                // 生成统计摘要
                const stats = [];
                if (report.summary.totalUrls > 0) stats.push(`<span><i class="bi bi-link-45deg"></i> ${report.summary.totalUrls}</span>`);
                if (report.summary.totalFileOps > 0) stats.push(`<span><i class="bi bi-file-earmark"></i> ${report.summary.totalFileOps}</span>`);
                if (report.summary.totalNetworkAct > 0) stats.push(`<span><i class="bi bi-globe"></i> ${report.summary.totalNetworkAct}</span>`);
                if (report.summary.suspiciousPatterns > 0) stats.push(`<span><i class="bi bi-exclamation-triangle"></i> ${report.summary.suspiciousPatterns}</span>`);

                return `
        <div class="report-item" onclick="viewReport('${encodedReportId}')">
            <div class="report-item-header">
                <div class="report-item-title">
                    <i class="bi ${icon}"></i>
                    <span>${displayId}</span>
                </div>
                <span class="risk-badge ${getRiskBadgeClass(report.summary.riskLevel)}">
                    ${getRiskLabel(report.summary.riskLevel)}
                </span>
            </div>
            <div class="report-item-meta">
                ${new Date(report.timestamp).toLocaleString()}
            </div>
            ${stats.length > 0 ? `<div class="report-item-stats">${stats.join('')}</div>` : ''}
            <div class="report-item-actions">
                <button class="btn-pill btn-outline-modern" style="padding: 0.375rem 0.75rem; font-size: 0.8rem;" onclick="event.stopPropagation(); downloadReport('${encodedReportId}')">
                    <i class="bi bi-download"></i> 下载
                </button>
                <button class="btn-pill btn-danger-modern" style="padding: 0.375rem 0.75rem; font-size: 0.8rem;" onclick="event.stopPropagation(); deleteReport('${encodedReportId}')">
                    <i class="bi bi-trash"></i> 删除
                </button>
            </div>
        </div>
    `}).join('');
        }
    } catch (error) {
        console.error('加载报告失败:', error);
        reportList.innerHTML = '<p class="text-danger">加载报告失败</p>';
    }
}

// 获取风险等级对应的CSS类
function getRiskBadgeClass(riskLevel) {
    const classes = {
        high: 'risk-badge-high',
        medium: 'risk-badge-medium',
        low: 'risk-badge-low',
        minimal: 'risk-badge-minimal',
        safe: 'risk-badge-safe',
        unknown: 'risk-badge-unknown'
    };
    return classes[riskLevel] || 'risk-badge-unknown';
}

/**
 * 将风险等级英文标识转为中文显示标签
 * @param {string} riskLevel - 风险等级英文标识
 * @returns {string} 中文风险标签
 */
function getRiskLabel(riskLevel) {
    const labels = {
        high: '高风险',
        medium: '中风险',
        low: '低风险',
        minimal: '极低风险',
        safe: '安全',
        unknown: '未知'
    };
    return labels[riskLevel] || '未知';
}

/**
 * 从报告HTML内容中提取风险等级（以报告内容为最可信来源）
 * @param {string} html - 报告HTML内容
 * @returns {string|null} 风险等级英文标识，未找到返回null
 */
function extractRiskFromHTML(html) {
    if (!html || typeof html !== 'string') return null;

    // 从 risk-badge-main 区域中提取中文风险标签
    const badgeMatch = html.match(/class="risk-badge-main"[\s\S]*?<span>([^<]+)<\/span>/);
    if (badgeMatch) {
        const label = badgeMatch[1].trim();
        const chineseToLevel = {
            '高危风险': 'high',
            '中危风险': 'medium',
            '低危风险': 'low',
            '极低风险': 'minimal',
            '安全': 'safe',
            '未知': 'unknown'
        };
        if (chineseToLevel[label]) return chineseToLevel[label];
    }

    return null;
}

async function viewReport(reportId, type = 'json', filename = '') {
    try {
        // 显示加载状态
        showAIStatus('正在加载报告...', '正在获取报告内容，请稍候...', 20);

        let html = '';
        let reportMeta = {
            id: reportId,
            filename: filename || '未知文件',
            riskLevel: 'unknown',
            analysisDate: new Date().toISOString()
        };

        if (type === 'html' && filename) {
            // 纯 AI HTML 报告，直接从静态目录读取
            updateAIStatusProgress(40, '正在读取AI生成的报告...');
            const response = await authFetch(`/reports/${filename}`);
            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`无法加载HTML报告: ${response.status} ${errText}`);
            }
            html = await response.text();
            // 尝试从文件名提取信息
            reportMeta.filename = filename.replace('.html', '').replace('report-', '');
        } else {
            // JSON 报告，首先尝试获取报告数据
            updateAIStatusProgress(30, '正在获取报告数据...');
            const response = await authFetch(`/api/report/${reportId}`);
            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`无法获取报告: ${response.status} ${errText}`);
            }
            const reportData = await response.json();

            // 【修复】兼容两种响应格式：
            // 1. 包裹格式: { report: { id, aiGeneratedReport, ... } } (来自 analyze 端点)
            // 2. 原始格式: { id, aiGeneratedReport, ... } (来自 GET /:id 端点)
            const report = reportData.report || reportData;

            // 提取报告元数据
            reportMeta.filename = report.filename || report.fileName ||
                (report.fileInfo && report.fileInfo.fileName) || '未知文件';
            reportMeta.riskLevel = report.riskLevel ||
                (report.summary && report.summary.riskLevel) ||
                (report.riskAssessment && report.riskAssessment.riskLevel) || 'unknown';
            reportMeta.analysisDate = report.analysisDate || report.createdAt || report.timestamp || new Date().toISOString();

            // 如果报告包含AI报告内容，直接使用它
            if (report.aiGeneratedReport &&
                typeof report.aiGeneratedReport === 'string' &&
                !String(report.aiGeneratedReport).startsWith('AI长文分析生成失败')) {
                updateAIStatusProgress(60, '正在加载AI分析报告...');
                html = report.aiGeneratedReport;
            } else {
                // 否则通过导出接口生成HTML
                updateAIStatusProgress(40, '正在生成报告HTML版本...');
                const exportResponse = await authFetch(`/api/report/${reportId}/export`);
                if (!exportResponse.ok) {
                    const errText = await exportResponse.text().catch(() => '');
                    throw new Error(`报告导出失败: ${exportResponse.status} ${errText}`);
                }
                html = await exportResponse.text();
            }
        }

        // 【关键】以报告HTML内容中的风险评级为最可信来源，同步到标题显示
        // 仅当HTML中有明确的风险等级（非"未知"）时才覆盖元数据
        if (html) {
            const htmlRisk = extractRiskFromHTML(html);
            if (htmlRisk && htmlRisk !== 'unknown') {
                reportMeta.riskLevel = htmlRisk;
            }
        }

        // 保存当前报告元数据
        currentReportMeta = reportMeta;

        updateAIStatusProgress(80, '正在准备显示报告...');

        // 更新报告头部信息
        updateReportHeader(reportMeta);

        // 注入自动高度调整脚本到 HTML 内容中，使 iframe 能自适应内容高度
        const resizeScript = `<script>
(function() {
    function sendHeight() {
        try {
            var h = Math.max(
                document.body.scrollHeight,
                document.body.offsetHeight,
                document.documentElement.scrollHeight,
                document.documentElement.offsetHeight
            );
            parent.postMessage({ type: 'reportFrameResize', height: h }, '*');
        } catch(e) {}
    }
    window.addEventListener('load', function() { sendHeight(); setTimeout(sendHeight, 500); });
    window.addEventListener('resize', sendHeight);
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(sendHeight).observe(document.body, { childList: true, subtree: true });
    }
})();
<\/script>`;

        if (html.includes('</body>')) {
            html = html.replace('</body>', resizeScript + '</body>');
        } else {
            html += resizeScript;
        }

        // 用 iframe 展示完整 HTML 报告，避免直接嵌入导致的渲染/脚本问题
        const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
        const url = window.URL.createObjectURL(blob);
        reportBody.innerHTML = `<iframe id="reportFrame" src="${url}" style="width:100%; height:500px; border:0; background:#fff;"></iframe>`;

        // 监听 iframe 发来的高度调整消息，动态调整 iframe 高度以完整显示报告
        if (window._reportFrameResizeHandler) {
            window.removeEventListener('message', window._reportFrameResizeHandler);
        }
        window._reportFrameResizeHandler = function (e) {
            if (e.data && e.data.type === 'reportFrameResize') {
                const frame = document.getElementById('reportFrame');
                if (frame) {
                    frame.style.height = Math.max(e.data.height, 500) + 'px';
                }
            }
        };
        window.addEventListener('message', window._reportFrameResizeHandler);

        reportViewer.style.display = 'block';
        document.body.style.overflow = 'hidden'; // 防止背景滚动

        updateAIStatusProgress(100, '报告加载完成！');
        setTimeout(hideAIStatus, 1500);
    } catch (error) {
        hideAIStatus();
        console.error('查看报告失败:', error);

        // 检查是否是404错误(文件不存在)
        if (error.message.includes('404') || error.message.includes('不存在')) {
            // 后端报告不存在,但前端可能还有缓存
            // 自动从前端列表中移除该项
            console.warn(`[viewReport] 报告(${reportId})在后端不存在,自动从列表中移除`);

            // 重新加载报告列表以获取最新状态
            loadReports();

            // 提示用户
            alert('该报告文件已不存在，已自动从列表中移除');
        } else {
            alert(`查看报告失败：${error.message || error}`);
        }
    }
}

// 更新报告头部信息
function updateReportHeader(meta) {
    // 更新报告标题 - 显示为"某某文件安全分析报告"
    const titleEl = document.getElementById('reportTitle');
    if (titleEl && meta.filename) {
        titleEl.textContent = meta.filename + ' 安全分析报告';
    }

    // 更新文件名
    const filenameEl = document.getElementById('reportFilename');
    if (filenameEl) {
        filenameEl.textContent = meta.filename;
    }

    // 更新日期和时间
    const date = new Date(meta.analysisDate);
    const dateEl = document.getElementById('reportDate');
    const timeEl = document.getElementById('reportTime');
    if (dateEl) {
        dateEl.textContent = date.toLocaleDateString('zh-CN');
    }
    if (timeEl) {
        timeEl.textContent = date.toLocaleTimeString('zh-CN');
    }

    // 更新风险等级徽章
    const riskBadge = document.getElementById('reportRiskBadge');
    const riskText = document.getElementById('reportRiskText');

    if (riskBadge && riskText) {
        // 移除旧的风险类
        riskBadge.classList.remove('report-risk-high', 'report-risk-medium', 'report-risk-low', 'report-risk-minimal', 'report-risk-safe', 'report-risk-unknown');

        // 根据风险等级设置样式
        const riskLevel = (meta.riskLevel || 'unknown').toLowerCase();
        let riskLabel = '未知';
        let iconClass = 'bi-question-circle-fill';

        switch (riskLevel) {
            case 'high':
            case 'danger':
            case 'critical':
                riskBadge.classList.add('report-risk-high');
                riskLabel = '高风险';
                iconClass = 'bi-exclamation-triangle-fill';
                break;
            case 'medium':
            case 'warning':
            case 'suspicious':
                riskBadge.classList.add('report-risk-medium');
                riskLabel = '中风险';
                iconClass = 'bi-exclamation-circle-fill';
                break;
            case 'low':
                riskBadge.classList.add('report-risk-low');
                riskLabel = '低风险';
                iconClass = 'bi-shield-fill-exclamation';
                break;
            case 'minimal':
                riskBadge.classList.add('report-risk-minimal');
                riskLabel = '极低风险';
                iconClass = 'bi-shield-check';
                break;
            case 'safe':
            case 'clean':
            case 'none':
                riskBadge.classList.add('report-risk-safe');
                riskLabel = '安全';
                iconClass = 'bi-shield-check';
                break;
            default:
                riskBadge.classList.add('report-risk-unknown');
                riskLabel = '未知';
                iconClass = 'bi-question-circle-fill';
        }

        riskText.textContent = riskLabel;
        riskBadge.innerHTML = `<i class="bi ${iconClass}"></i><span>${riskLabel}</span>`;
    }
}

// 下载当前报告
async function downloadCurrentReport() {
    if (!currentReportMeta) {
        alert('没有可下载的报告');
        return;
    }

    try {
        await downloadReport(currentReportMeta.id);
    } catch (error) {
        console.error('下载报告失败:', error);
        alert('下载报告失败: ' + error.message);
    }
}

// 下载当前PDF报告
async function downloadPdfReport() {
    if (!currentReportMeta) {
        alert('没有可下载的报告');
        return;
    }

    try {
        await downloadPdf(currentReportMeta.id);
    } catch (error) {
        console.error('下载PDF报告失败:', error);
        alert('下载PDF报告失败: ' + error.message);
    }
}

// 下载PDF报告
async function downloadPdf(reportId) {
    try {
        // 显示下载状态
        showAIStatus('正在生成PDF...', '正在将报告转换为PDF格式，请稍候...', 10);

        updateAIStatusProgress(30, '正在生成PDF文件...');

        // 请求PDF下载
        const response = await authFetch(`/api/report/${reportId}/download/pdf`);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'PDF生成失败');
        }

        updateAIStatusProgress(70, '正在下载PDF文件...');

        // 获取PDF blob
        const blob = await response.blob();

        // 获取文件名（优先解析filename*=UTF-8''格式以支持中文文件名）
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'report.pdf';
        if (contentDisposition) {
            // 尝试匹配 filename*=UTF-8'' 格式（RFC 5987编码）
            const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
            if (utf8Match) {
                filename = decodeURIComponent(utf8Match[1]);
            } else {
                // 尝试匹配 filename="..." 格式
                const asciiMatch = contentDisposition.match(/filename="([^"]+)"/i);
                if (asciiMatch) {
                    filename = asciiMatch[1];
                }
            }
        }

        // 创建下载链接
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        hideAIStatus();

    } catch (error) {
        console.error('下载PDF失败:', error);
        hideAIStatus();
        throw error;
    }
}

// 打印当前报告
function printCurrentReport() {
    const frame = document.getElementById('reportFrame');
    if (!frame) {
        alert('报告尚未加载完成');
        return;
    }

    try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
    } catch (error) {
        console.error('打印报告失败:', error);
        // 备用方案：打开新窗口打印
        const html = frame.srcdoc || '<html><body>报告内容</body></html>';
        const printWindow = window.open('', '_blank');
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
    }
}

// 下载报告
async function downloadReport(reportId) {
    try {
        // 显示下载状态
        showAIStatus('正在准备下载...', '正在获取报告文件，请稍候...', 10);

        // 优先尝试下载HTML报告
        updateAIStatusProgress(30, '正在检查HTML报告...');
        const htmlResponse = await authFetch(`/api/report/${reportId}/download`);

        if (htmlResponse.ok) {
            // HTML报告存在，下载它
            updateAIStatusProgress(60, '正在下载HTML报告...');
            const blob = await htmlResponse.blob();

            // 从Content-Disposition头部获取文件名
            let filename = `${reportId}.html`;
            const contentDisposition = htmlResponse.headers.get('Content-Disposition');
            if (contentDisposition) {
                // 尝试匹配 filename*=UTF-8'' 格式
                const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
                if (utf8Match) {
                    filename = decodeURIComponent(utf8Match[1]);
                } else {
                    // 尝试匹配 filename="..." 格式
                    const asciiMatch = contentDisposition.match(/filename="([^"]+)"/i);
                    if (asciiMatch) {
                        filename = asciiMatch[1];
                    }
                }
            }

            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);

            updateAIStatusProgress(100, '下载完成！');
            setTimeout(hideAIStatus, 1500);
        } else {
            // HTML报告不存在，下载JSON报告的HTML导出版本
            updateAIStatusProgress(50, 'HTML报告不存在，正在生成导出版本...');
            const jsonResponse = await authFetch(`/api/report/${reportId}/export`);
            if (jsonResponse.ok) {
                updateAIStatusProgress(80, '正在准备下载文件...');
                const html = await jsonResponse.text();

                // 从Content-Disposition头部获取文件名
                let filename = `${reportId}.html`;
                const contentDisposition = jsonResponse.headers.get('Content-Disposition');
                if (contentDisposition) {
                    // 尝试匹配 filename*=UTF-8'' 格式
                    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
                    if (utf8Match) {
                        filename = decodeURIComponent(utf8Match[1]);
                    } else {
                        // 尝试匹配 filename="..." 格式
                        const asciiMatch = contentDisposition.match(/filename="([^"]+)"/i);
                        if (asciiMatch) {
                            filename = asciiMatch[1];
                        }
                    }
                }

                const blob = new Blob([html], { type: 'text/html' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);

                updateAIStatusProgress(100, '下载完成！');
                setTimeout(hideAIStatus, 1500);
            } else {
                hideAIStatus();
                const errText = await jsonResponse.text().catch(() => '');
                alert(`下载失败：${jsonResponse.status} ${errText || '报告不存在或导出失败'}`);
            }
        }
    } catch (error) {
        hideAIStatus();
        console.error('下载报告失败:', error);
        alert(`下载报告失败：${error.message || error}`);
    }
}

// 删除报告
async function deleteReport(reportId) {
    try {
        // 尝试删除HTML报告
        let htmlResponse;
        try {
            htmlResponse = await authFetch(`/api/report/${reportId}/html`, {
                method: 'DELETE'
            });
        } catch (e) {
            console.warn(`[deleteReport] 删除HTML报告请求失败:`, e.message);
        }

        // 同时也尝试删除JSON报告
        let jsonResponse;
        try {
            jsonResponse = await authFetch(`/api/report/${reportId}`, {
                method: 'DELETE'
            });
        } catch (e) {
            console.warn(`[deleteReport] 删除JSON报告请求失败:`, e.message);
        }

        // 检查响应状态,如果都是404则说明报告不存在
        const htmlStatus = htmlResponse ? htmlResponse.status : 0;
        const jsonStatus = jsonResponse ? jsonResponse.status : 0;

        if ((htmlStatus === 404 || !htmlResponse) && (jsonStatus === 404 || !jsonResponse)) {
            // 报告不存在,立即从UI中移除
            console.warn(`[deleteReport] 报告(${reportId})不存在,立即从UI移除`);
            removeReportFromUI(reportId);
            alert('该报告文件已不存在，已自动从列表中移除');
            return;
        }

        alert('报告删除成功');

        // 删除成功后，从UI中移除并刷新报告列表
        removeReportFromUI(reportId);
        await loadReports();
    } catch (error) {
        console.error('删除报告失败:', error);
        alert('删除报告失败: ' + error.message);
    }
}

// 从UI中移除报告项(立即操作,无需刷新)
function removeReportFromUI(reportId) {
    const decodedReportId = decodeURIComponent(reportId);

    // 查找包含该报告ID的report-item元素
    const reportItems = document.querySelectorAll('.report-item');
    reportItems.forEach(item => {
        const reportInfoElement = item.querySelector('span i.bi-file-earmark-text');
        if (reportInfoElement) {
            const itemText = item.textContent;
            if (itemText.includes(decodedReportId) || itemText.includes(reportId)) {
                // 找到匹配的项，移除它
                item.remove();
                console.log(`[removeReportFromUI] 已从UI中移除报告: ${decodedReportId}`);

                // 检查是否已无报告，显示空状态
                const reportListEl = document.getElementById('reportList');
                if (reportListEl) {
                    const remainingItems = reportListEl.querySelectorAll('.report-item');
                    if (remainingItems.length === 0) {
                        reportListEl.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><p>暂无检测报告</p></div>';
                    }
                }
            }
        }
    });
}

// 关闭报告
function closeReport() {
    reportViewer.style.display = 'none';
    document.body.style.overflow = ''; // 恢复背景滚动
    currentReportMeta = null; // 清除当前报告元数据
    // 清理 iframe 高度调整监听器
    if (window._reportFrameResizeHandler) {
        window.removeEventListener('message', window._reportFrameResizeHandler);
        window._reportFrameResizeHandler = null;
    }
}
