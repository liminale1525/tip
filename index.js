import { eventSource, event_types, saveSettingsDebounced, is_send_press } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';

const extensionName = 'tip';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// 默认设置
const defaultSettings = {
    soundEnabled: true,      // 音效开关
    flashTabEnabled: true,   // 标签页闪烁开关
    volume: 0.5,
    successSound: '清脆风铃声.mp3',  // 成功提示音文件名
    errorSound: '清脆回响水滴声.mp3',  // 错误提示音文件名
    // 自定义音频改为存储在设置中（base64 dataURL），以便跨设备同步
    customAudios: { success: [], error: [] }
};

// 设置 Favicon 的辅助函数
function setFavicon(href, useCacheBuster = false) {
    let faviconLink = document.querySelector("link[rel='icon']") || document.querySelector("link[rel='shortcut icon']");

    if (!faviconLink) {
        faviconLink = document.createElement('link');
        faviconLink.rel = 'shortcut icon';
        faviconLink.type = 'image/x-icon';
        document.head.appendChild(faviconLink);
    }

    let finalHref = href;
    if (useCacheBuster) {
        finalHref += `?v=${Date.now()}`;
    }

    faviconLink.href = finalHref;
}

// 标签页闪烁管理器
const tabFlasher = {
    originalTitle: document.title,
    originalFavicon: document.querySelector("link[rel='icon']")?.href || document.querySelector("link[rel='shortcut icon']")?.href || '/favicon.ico',
    intervalId: null,
    isFlashing: false,

    // 闪烁用的 Favicon 路径
    orangeFavicon: `/${extensionFolderPath}/Doro1.ico`,
    yellowFavicon: `/${extensionFolderPath}/Doro2.ico`,

    start: function (newTitle) {
        if (this.isFlashing || document.hasFocus()) return;

        this.isFlashing = true;
        let state = 0;

        this.intervalId = setInterval(() => {
            if (state === 0) {
                document.title = newTitle;
                setFavicon(this.orangeFavicon, true);
                state = 1;
            } else {
                document.title = this.originalTitle;
                setFavicon(this.yellowFavicon, true);
                state = 0;
            }
        }, 800);
    },

    stop: function () {
        if (!this.isFlashing) return;

        this.isFlashing = false;
        clearInterval(this.intervalId);
        document.title = this.originalTitle;
        setFavicon(this.originalFavicon, false);
    }
};

// 当用户切换回此标签页时，停止闪烁
window.addEventListener('focus', () => {
    tabFlasher.stop();
});

// 音频对象
let successSound = null;  // 成功提示音
let errorSound = null;    // 错误提示音

// 可用音频文件列表
let successAudioFiles = [];
let errorAudioFiles = [];

// 自定义音频（存储在 extension_settings 中，base64 dataURL，跨设备同步）
// 旧版本使用 IndexedDB，仅用于一次性迁移到设置中
const IDB_DB_NAME = 'tip';
const IDB_STORE = 'audios';

/**
 * 自定义音频清单存储在 extension_settings[extensionName].customAudios
 * 项结构：
 * { id, kind: 'success'|'error', name, mime, size, createdAt, dataUrl }
 * settings.successSound / errorSound 用 "idb:<id>" 引用（保留前缀以兼容旧设置）
 */
let idbDb = null;

// 读取设置中的自定义清单（带容错）
function getCustomAudios() {
    const settings = extension_settings[extensionName];
    if (!settings.customAudios || typeof settings.customAudios !== 'object') {
        settings.customAudios = { success: [], error: [] };
    }
    if (!Array.isArray(settings.customAudios.success)) settings.customAudios.success = [];
    if (!Array.isArray(settings.customAudios.error)) settings.customAudios.error = [];
    return settings.customAudios;
}

// 跟踪生成状态
let generationState = {
    isGenerating: false,
    wasStoppedOrError: false,
    lastErrorTime: 0
};

// 初始化扩展
jQuery(async () => {
   // 加载设置
   if (!extension_settings[extensionName]) {
       extension_settings[extensionName] = defaultSettings;
   }

   // 兼容旧设置：将 enabled 迁移到 soundEnabled
   const settings = extension_settings[extensionName];
   if (settings.enabled !== undefined && settings.soundEnabled === undefined) {
       settings.soundEnabled = settings.enabled;
       delete settings.enabled;
   }
   // 确保新属性存在
   if (settings.soundEnabled === undefined) {
       settings.soundEnabled = defaultSettings.soundEnabled;
   }
   if (settings.flashTabEnabled === undefined) {
       settings.flashTabEnabled = defaultSettings.flashTabEnabled;
   }
   // 确保自定义音频结构存在
   getCustomAudios();

   // 读取自定义音频清单（设置中），并迁移旧的 IndexedDB 数据（如有）
   try {
       await loadCustomAudios();
   } catch (e) {
       console.warn(`[${extensionName}] 自定义音频读取/迁移失败:`, e);
   }

   // 扫描内置音频文件（可选）
   await scanAudioFiles();

   // 初始化音频
   initAudio();

   // 注册事件监听器
   registerEventListeners();

   // 添加设置界面
   addSettingsUI();

   console.log(`[${extensionName}] 扩展已加载`);
});

// 扫描音频文件夹中的所有音频文件
async function scanAudioFiles() {
    // 优先读取 audio/index.json 清单（最可靠，支持任意文件名与 flac/wav/ogg）
    async function getFilesFromManifest() {
        try {
            const url = `/${extensionFolderPath}/audio/index.json`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1500);
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) return null;
            const data = await response.json();
            return {
                success: Array.isArray(data.success) ? data.success : [],
                error: Array.isArray(data.error) ? data.error : [],
            };
        } catch (e) {
            return null;
        }
    }

    // 获取文件列表（回退方案：当没有 index.json 时，探测常见文件名）
    async function getFilesFromFolder(folderType) {
        const testFiles = new Set();

        // 根据文件夹类型添加常见文件
        if (folderType === 'success') {
            ['voice.mp3', 'okay.mp3', '叮咚鸡！.mp3', 'success.mp3',
             'complete.mp3', 'done.mp3', 'notify.mp3', '星际曼波.mp3', '哈基米.mp3', '花Q.mp3',
             'Ciallo.mp3', '咕咕嘎嘎.wav', '奖励.mp3', '曼波.mp3', '曼波欧耶.mp3', '曼波傻笑.mp3',
             '新的订单查收.mp3', 'man！.mp3', 'what can i say.mp3', '曼巴out.mp3'].forEach(f => testFiles.add(f));
        } else {
            ['error_normal.mp3', 'error.mp3', 'fail.mp3', 'warning.mp3', 'faq.mp3',
             '星际曼波.mp3', '哈基米.mp3', 'another.mp3', 'Ciallo.mp3',
             '我劝你别用.mp3', '曼波傻笑.mp3', '曼波欧耶.mp3', '曼波.mp3', '奖励.mp3',
             '咕咕嘎嘎.wav', '钢管（音量注意）.mp3', 'man！.mp3', 'what can i say.mp3',
             '曼巴out.mp3'].forEach(f => testFiles.add(f));
        }

        // 添加用户可能添加的文件名（减少测试数量）
        // 单个字母 A-Z（只测试大写）
        for (let i = 65; i <= 90; i++) {
            testFiles.add(`${String.fromCharCode(i)}.mp3`);
        }

        // 数字 1-10
        for (let i = 1; i <= 10; i++) {
            testFiles.add(`${i}.mp3`);
        }

        // 测试文件是否存在（静默处理404）
        const existingFiles = [];
        for (const filename of testFiles) {
            const testUrl = `/${extensionFolderPath}/audio/${folderType}/${filename}`;

            // 使用AbortController来设置超时
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 500);

            try {
                const response = await fetch(testUrl, {
                    method: 'HEAD',
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.ok) {
                    existingFiles.push(filename);
                    console.log(`[${extensionName}] 找到文件: ${folderType}/${filename}`);
                }
            } catch (e) {
                clearTimeout(timeoutId);
                // 静默处理错误，不输出到控制台
            }
        }

        return existingFiles;
    }

    // 优先使用清单文件
    const manifest = await getFilesFromManifest();

    // 扫描成功音频文件
    const newSuccessFiles = manifest ? manifest.success : await getFilesFromFolder('success');
    const successChanged = JSON.stringify(successAudioFiles) !== JSON.stringify(newSuccessFiles);
    successAudioFiles = newSuccessFiles;

    // 扫描错误音频文件
    const newErrorFiles = manifest ? manifest.error : await getFilesFromFolder('error');
    const errorChanged = JSON.stringify(errorAudioFiles) !== JSON.stringify(newErrorFiles);
    errorAudioFiles = newErrorFiles;

    if (manifest) {
        console.log(`[${extensionName}] 已从 index.json 加载内置音频清单`);
    }

    // 显示扫描结果
    if (successAudioFiles.length === 0) {
        console.warn(`[${extensionName}] 未找到成功音频文件，请在 audio/success/ 文件夹中放置音频文件`);
    } else {
        console.log(`[${extensionName}] 找到成功音频: ${successAudioFiles.join(', ')}`);
    }

    if (errorAudioFiles.length === 0) {
        console.warn(`[${extensionName}] 未找到错误音频文件，请在 audio/error/ 文件夹中放置音频文件`);
    } else {
        console.log(`[${extensionName}] 找到错误音频: ${errorAudioFiles.join(', ')}`);
    }

    return { successChanged, errorChanged };
}

// ===== 自定义音频（仅 IndexedDB，本地上传）功能 =====

// 打开或初始化 IndexedDB
async function initIDB() {
    if (idbDb) return idbDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_DB_NAME, 1);
        request.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = (ev) => {
            idbDb = ev.target.result;
            resolve(idbDb);
        };
        request.onerror = () => reject(request.error);
    });
}

// 生成UUID
function vt_uuid() {
    try {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    } catch {}
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// 从 IDB 读取清单并迁移到设置中（仅一次性迁移旧数据）
async function loadCustomAudios() {
    const custom = getCustomAudios();
    try {
        await initIDB();
    } catch {
        return; // 没有 IDB 也无妨，设置中已有数据
    }
    return new Promise((resolve) => {
        let tx;
        try {
            tx = idbDb.transaction(IDB_STORE, 'readonly');
        } catch {
            resolve();
            return;
        }
        const store = tx.objectStore(IDB_STORE);
        const req = store.getAll();
        req.onsuccess = async () => {
            const items = (req.result || []).filter(x => x?.type === 'idb' && x.data);
            if (!items.length) { resolve(); return; }

            // 将旧的 Blob 数据迁移为 dataURL 存入设置
            let migrated = 0;
            for (const it of items) {
                const exists = [...custom.success, ...custom.error].some(x => x.id === it.id);
                if (exists) continue;
                try {
                    const dataUrl = await blobToDataURL(it.data);
                    const rec = {
                        id: it.id,
                        kind: it.kind,
                        name: it.name || 'audio',
                        mime: it.mime || it.data.type || 'audio/mpeg',
                        size: it.size || it.data.size || 0,
                        createdAt: it.createdAt || 0,
                        dataUrl,
                    };
                    (rec.kind === 'error' ? custom.error : custom.success).push(rec);
                    migrated++;
                } catch (e) {
                    console.warn(`[${extensionName}] 迁移自定义音频失败:`, e);
                }
            }
            if (migrated > 0) {
                console.log(`[${extensionName}] 已将 ${migrated} 个本地自定义音频迁移到同步设置`);
                saveSettingsDebounced();
                // 迁移后清空旧 IDB 数据，避免重复
                try {
                    const delTx = idbDb.transaction(IDB_STORE, 'readwrite');
                    delTx.objectStore(IDB_STORE).clear();
                } catch {}
            }
            resolve();
        };
        req.onerror = () => resolve();
    });
}

// 将 Blob/File 转为 dataURL
function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

// 新增本地文件（转为 dataURL 存入设置，跨设备同步）
async function addCustomFile(kind, file) {
    const custom = getCustomAudios();
    const id = vt_uuid();
    const dataUrl = await blobToDataURL(file);
    const rec = {
        id,
        kind, // 'success' | 'error'
        name: file.name || 'audio',
        mime: file.type || 'audio/mpeg',
        size: file.size || 0,
        createdAt: Date.now(),
        dataUrl,
    };
    (kind === 'error' ? custom.error : custom.success).push(rec);
    saveSettingsDebounced();
    return rec;
}

// 删除自定义项
async function deleteCustomItem(id) {
    const custom = getCustomAudios();
    custom.success = custom.success.filter(x => x.id !== id);
    custom.error = custom.error.filter(x => x.id !== id);
    saveSettingsDebounced();
}

// 查询自定义项
function getCustomById(kind, id) {
    const custom = getCustomAudios();
    return (custom[kind] || []).find(x => x.id === id);
}

// 构建 Audio 实例（支持 内置/自定义 dataURL）
function buildAudioFor(kind, value) {
    try {
        if (!value) return null;

        let src = '';

        if (typeof value === 'string' && value.startsWith('idb:')) {
            const id = value.slice(4);
            const rec = getCustomById(kind, id);
            if (rec && rec.dataUrl) {
                src = rec.dataUrl;
            }
        } else {
            // 内置文件
            src = `/${extensionFolderPath}/audio/${kind}/${value}`;
        }

        if (!src) return null;

        const audio = new Audio(src);
        audio.volume = extension_settings[extensionName].volume;
        audio.load();
        return audio;
    } catch (error) {
        console.error(`[${extensionName}] 构建音频失败:`, error);
        return null;
    }
}

// 初始化音频
function initAudio() {
    const settings = extension_settings[extensionName];

    try {
        // 成功提示音（支持 内置/IDB）
        if (settings.successSound) {
            const a = buildAudioFor('success', settings.successSound);
            successSound = a;
        } else {
            successSound = null;
        }

        // 错误提示音（支持 内置/IDB）
        if (settings.errorSound) {
            const a2 = buildAudioFor('error', settings.errorSound);
            errorSound = a2;
        } else {
            errorSound = null;
        }
    } catch (error) {
        console.error(`[${extensionName}] 无法加载音频文件:`, error);
    }
}

// 注册事件监听器
function registerEventListeners() {
    // 监听生成开始事件
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    // 监听生成停止事件（错误或手动停止）
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

    // 监听生成结束事件（正常完成）
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

    // 监听toastr错误消息来检测API错误
    interceptToastrErrors();

    // 拦截fetch响应来检测HTTP错误
    interceptFetchErrors();
}

// 生成开始时
function onGenerationStarted() {
    generationState.isGenerating = true;
    generationState.wasStoppedOrError = false;
    console.log(`[${extensionName}] AI开始生成回复`);
}

// 拦截fetch响应来检测HTTP错误
function interceptFetchErrors() {
    const originalFetch = window.fetch;

    window.fetch = async function(...args) {
        try {
            const response = await originalFetch.apply(this, args);
            const url = args[0]?.toString() || '';

            // 检查是否是API请求且返回错误状态
            if (url.includes('/api/') && !response.ok && response.status >= 400) {
                const errorInfo = `HTTP ${response.status} ${response.statusText}`;
                console.log(`[${extensionName}] 检测到HTTP错误: ${errorInfo} - ${url}`);

                // 如果正在生成AI回复，记录错误
                if (generationState.isGenerating) {
                    generationState.wasStoppedOrError = true;
                    generationState.lastErrorTime = Date.now();

                    // 延迟播放错误音，让toastr先显示
                    if (extension_settings[extensionName].soundEnabled) {
                        setTimeout(() => {
                            playErrorSound();
                        }, 200);
                    }
                }
            }

            return response;
        } catch (error) {
            // 网络错误（无法连接、超时等）
            const url = args[0]?.toString() || '';
            if (url.includes('/api/') && generationState.isGenerating) {
                console.log(`[${extensionName}] 检测到网络错误: ${error.message}`);
                generationState.wasStoppedOrError = true;
                generationState.lastErrorTime = Date.now();

                if (extension_settings[extensionName].soundEnabled) {
                    setTimeout(() => {
                        playErrorSound();
                    }, 200);
                }
            }
            throw error;
        }
    };
}

// 拦截toastr错误消息
function interceptToastrErrors() {
    // 保存原始的toastr.error函数
    const originalToastrError = window.toastr.error;

    // 定义HTTP错误码列表
    const httpErrorPatterns = [
        // 4xx 客户端错误
        /\b400\b/, /\b401\b/, /\b402\b/, /\b403\b/, /\b404\b/,
        /\b405\b/, /\b406\b/, /\b407\b/, /\b408\b/, /\b409\b/,
        /\b410\b/, /\b411\b/, /\b412\b/, /\b413\b/, /\b414\b/,
        /\b415\b/, /\b416\b/, /\b417\b/, /\b418\b/, /\b421\b/,
        /\b422\b/, /\b423\b/, /\b424\b/, /\b425\b/, /\b426\b/,
        /\b428\b/, /\b429\b/, /\b431\b/, /\b451\b/,
        // 5xx 服务器错误
        /\b500\b/, /\b501\b/, /\b502\b/, /\b503\b/, /\b504\b/,
        /\b505\b/, /\b506\b/, /\b507\b/, /\b508\b/, /\b510\b/, /\b511\b/,
        // 常见错误关键词
        /unauthorized/i, /forbidden/i, /not found/i, /bad request/i,
        /internal server error/i, /service unavailable/i, /gateway timeout/i,
        /too many requests/i, /rate limit/i, /quota exceeded/i,
        /network error/i, /connection refused/i, /timeout/i,
        /failed to fetch/i, /fetch error/i, /request failed/i,
        /ECONNREFUSED/, /ETIMEDOUT/, /ENOTFOUND/, /ECONNRESET/
    ];

    // 重写toastr.error函数
    window.toastr.error = function(message, title, options) {
        const fullText = `${title || ''} ${message || ''}`;
        let isApiError = false;
        let errorType = 'unknown';

        // 检查是否包含API关键词
        if (title && (title.includes('API') || title.includes('Error') || title.includes('Failed'))) {
            isApiError = true;
            errorType = 'api_keyword';
        }

        // 检查是否包含HTTP错误码或错误关键词
        for (const pattern of httpErrorPatterns) {
            if (pattern.test(fullText)) {
                isApiError = true;
                errorType = pattern.source;
                break;
            }
        }

        // 检测到错误时的处理
        if (isApiError) {
            console.log(`[${extensionName}] 检测到错误 [${errorType}]: ${fullText}`);
            generationState.wasStoppedOrError = true;
            generationState.lastErrorTime = Date.now();

            // 如果正在生成，播放错误音
            if (generationState.isGenerating && extension_settings[extensionName].soundEnabled) {
                setTimeout(() => {
                    playErrorSound();
                }, 100); // 小延迟确保其他处理完成
            }
        }

        // 调用原始函数
        return originalToastrError.call(this, message, title, options);
    };
}

// 生成停止时（错误或手动停止）
function onGenerationStopped() {
    const settings = extension_settings[extensionName];

    generationState.wasStoppedOrError = true;
    generationState.isGenerating = false;
    console.log(`[${extensionName}] AI生成被手动停止`);

    // 只在手动停止时播放错误音（API错误由toastr拦截处理）
    // 检查是否刚刚有API错误（1秒内）
    const timeSinceError = Date.now() - generationState.lastErrorTime;
    if (settings.soundEnabled && timeSinceError > 1000) {
        playErrorSound();
    }
}

// 生成正常结束时
function onGenerationEnded() {
    const settings = extension_settings[extensionName];

    // 检查是否有错误发生（包括API错误）
    const hasError = generationState.wasStoppedOrError ||
                    (Date.now() - generationState.lastErrorTime < 2000);

    // 成功完成时的处理
    if (!hasError && generationState.isGenerating) {
        // 播放成功音（独立判断）
        if (settings.soundEnabled) {
            console.log(`[${extensionName}] AI回复成功，播放成功音`);
            playSuccessSound();
        }

        // 标签页闪烁（独立判断）
        if (settings.flashTabEnabled && !document.hasFocus()) {
            tabFlasher.start('【新消息！】');
        }
    } else if (settings.soundEnabled && hasError) {
        console.log(`[${extensionName}] 生成结束但有错误，不播放成功音`);
    }

    // 重置状态
    generationState.isGenerating = false;
    generationState.wasStoppedOrError = false;
}

// 播放成功提示音
function playSuccessSound() {
    if (!successSound) {
        console.warn(`[${extensionName}] 成功音频未初始化，尝试重新初始化`);
        initAudio();
        if (!successSound) return;
    }

    try {
        // 重置音频以支持快速连续播放
        successSound.currentTime = 0;
        successSound.volume = extension_settings[extensionName].volume;

        // 播放音频
        successSound.play().catch(error => {
            console.error(`[${extensionName}] 播放成功提示音失败:`, error);
            // 尝试重新创建音频对象
            initAudio();
        });
    } catch (error) {
        console.error(`[${extensionName}] 播放成功提示音失败:`, error);
    }
}

// 播放错误提示音
function playErrorSound() {
    if (!errorSound) {
        console.warn(`[${extensionName}] 错误音频未初始化，尝试重新初始化`);
        initAudio();
        if (!errorSound) return;
    }

    try {
        // 重置音频以支持快速连续播放
        errorSound.currentTime = 0;
        errorSound.volume = extension_settings[extensionName].volume;

        // 播放音频
        errorSound.play().catch(error => {
            console.error(`[${extensionName}] 播放错误提示音失败:`, error);
            // 尝试重新创建音频对象
            initAudio();
        });
    } catch (error) {
        console.error(`[${extensionName}] 播放错误提示音失败:`, error);
    }
}

// 更新下拉框选项
function updateSelectOptions() {
    const successSelect = $('#tip-success-select');
    const errorSelect = $('#tip-error-select');

    // 清空现有选项
    successSelect.empty();
    errorSelect.empty();

    // 添加默认选项
    successSelect.append('<option value="">无</option>');
    errorSelect.append('<option value="">无</option>');

    // 工具函数
    const addOption = (select, value, label) => {
        select.append(`<option value="${value}">${label}</option>`);
    };

    // 添加内置成功音频文件
    if (successAudioFiles.length > 0) {
        successAudioFiles.forEach(file => {
            const displayName = file.replace(/\.[^/.]+$/, "");
            addOption(successSelect, file, displayName);
        });
    } else {
        successSelect.append('<option value="" disabled>请上传，或在 audio/success/ 放置音频文件</option>');
    }

    // 添加内置错误音频文件
    if (errorAudioFiles.length > 0) {
        errorAudioFiles.forEach(file => {
            const displayName = file.replace(/\.[^/.]+$/, "");
            addOption(errorSelect, file, displayName);
        });
    } else {
        errorSelect.append('<option value="" disabled>请上传，或在 audio/error/ 放置音频文件</option>');
    }

    // 添加自定义成功项
    const custom = getCustomAudios();
    (custom.success || []).forEach(rec => {
        const value = `idb:${rec.id}`;
        const label = `[自定义] ${rec.name || ('音频 ' + rec.id.slice(0,6))}`;
        addOption(successSelect, value, label);
    });

    // 添加自定义错误项
    (custom.error || []).forEach(rec => {
        const value = `idb:${rec.id}`;
        const label = `[自定义] ${rec.name || ('音频 ' + rec.id.slice(0,6))}`;
        addOption(errorSelect, value, label);
    });

    // 设置当前值
    const settings = extension_settings[extensionName];

    // 成功选择回显（仅支持 idb 与内置）
    (function() {
        const val = settings.successSound;
        if (!val) {
            successSelect.val('');
            return;
        }
        if (typeof val === 'string' && val.startsWith('idb:')) {
            const id = val.slice(4);
            const exists = !!getCustomById('success', id);
            if (exists) {
                successSelect.val(val);
                return;
            }
        } else if (typeof val === 'string' && successAudioFiles.includes(val)) {
            successSelect.val(val);
            return;
        }
        successSelect.val('');
        settings.successSound = '';
    })();

    // 错误选择回显（仅支持 idb 与内置）
    (function() {
        const val = settings.errorSound;
        if (!val) {
            errorSelect.val('');
            return;
        }
        if (typeof val === 'string' && val.startsWith('idb:')) {
            const id = val.slice(4);
            const exists = !!getCustomById('error', id);
            if (exists) {
                errorSelect.val(val);
                return;
            }
        } else if (typeof val === 'string' && errorAudioFiles.includes(val)) {
            errorSelect.val(val);
            return;
        }
        errorSelect.val('');
        settings.errorSound = '';
    })();

    // 更新删除按钮的显示状态
    updateDeleteButtonVisibility();
}

// 更新删除按钮的显示状态（仅当选中自定义音效时显示）
function updateDeleteButtonVisibility() {
    const settings = extension_settings[extensionName];

    // 成功音效删除按钮
    const successVal = settings.successSound;
    const isSuccessCustom = typeof successVal === 'string' && successVal.startsWith('idb:');
    $('#tip-delete-success').toggle(isSuccessCustom);

    // 错误音效删除按钮
    const errorVal = settings.errorSound;
    const isErrorCustom = typeof errorVal === 'string' && errorVal.startsWith('idb:');
    $('#tip-delete-error').toggle(isErrorCustom);
}

// 添加设置界面
function addSettingsUI() {
    const settingsHtml = `
    <div id="tip-settings">
        <div class="inline-drawer">
            <div id="tip-header" class="inline-drawer-toggle inline-drawer-header">
                <b>消息小提示</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div id="tip-content" class="inline-drawer-content" style="display: none;">
                <div style="padding: 10px;">
                    <div style="display: flex; gap: 20px; margin-bottom: 10px;">
                        <label class="checkbox_label">
                            <input id="tip-sound-enabled" type="checkbox" />
                            <span>启用提示音</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="tip-flash-enabled" type="checkbox" />
                            <span>启用标签页闪烁</span>
                        </label>
                    </div>

                    <!-- 提示信息 -->
                    <div style="margin-bottom: 10px; font-size: 12px; color: #888; line-height: 1.4;">
                        内置音频自动加载；也可上传本地音频（≤5MB，跨设备同步）。支持 mp3/wav/ogg/flac。
                    </div>

                    <!-- 成功提示音选择 -->
                    <div style="margin-bottom: 10px;">
                        <label>成功提示音:</label>
                        <div style="display: flex; gap: 5px; align-items: center; flex-wrap: wrap;">
                            <select id="tip-success-select" class="text_pole" style="flex: 1; min-width: 220px;">
                                <option value="">无</option>
                            </select>
                            <button id="tip-test-success" class="menu_button" title="测试">
                                <i class="fa-solid fa-play"></i>
                            </button>
                            <button id="tip-upload-success" class="menu_button" title="上传本地文件">
                                <i class="fa-solid fa-upload"></i>
                            </button>
                            <button id="tip-delete-success" class="menu_button" title="删除当前自定义音效" style="display:none;">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                            <input id="tip-file-success" type="file" accept="audio/*,.mp3,.wav,.ogg,.flac" style="display:none" />
                        </div>
                    </div>

                    <!-- 错误提示音选择 -->
                    <div style="margin-bottom: 10px;">
                        <label>错误提示音:</label>
                        <div style="display: flex; gap: 5px; align-items: center; flex-wrap: wrap;">
                            <select id="tip-error-select" class="text_pole" style="flex: 1; min-width: 220px;">
                                <option value="">无</option>
                            </select>
                            <button id="tip-test-error" class="menu_button" title="测试">
                                <i class="fa-solid fa-play"></i>
                            </button>
                            <button id="tip-upload-error" class="menu_button" title="上传本地文件">
                                <i class="fa-solid fa-upload"></i>
                            </button>
                            <button id="tip-delete-error" class="menu_button" title="删除当前自定义音效" style="display:none;">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                            <input id="tip-file-error" type="file" accept="audio/*,.mp3,.wav,.ogg,.flac" style="display:none" />
                        </div>
                    </div>

                    <!-- 音量控制 -->
                    <div style="margin-bottom: 10px;">
                        <label>
                            <div>音量: <span id="tip-volume-value">50</span>%</div>
                            <input id="tip-volume" type="range" min="0" max="100" value="50" style="width: 100%;" />
                        </label>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    // 添加到扩展设置面板
    $('#extensions_settings').append(settingsHtml);

    // 绑定设置控件
    bindSettingsControls();

    // 更新下拉框选项
    updateSelectOptions();
}

// 绑定设置控件
function bindSettingsControls() {
    const settings = extension_settings[extensionName];

    // 音效开关
    $('#tip-sound-enabled')
        .prop('checked', settings.soundEnabled)
        .on('change', function() {
            settings.soundEnabled = $(this).prop('checked');
            saveSettingsDebounced();
        });

    // 标签页闪烁开关
    $('#tip-flash-enabled')
        .prop('checked', settings.flashTabEnabled)
        .on('change', function() {
            settings.flashTabEnabled = $(this).prop('checked');
            saveSettingsDebounced();
        });

    // 成功音选择
    $('#tip-success-select').on('change', function() {
        settings.successSound = $(this).val();
        saveSettingsDebounced();
        initAudio();
        updateDeleteButtonVisibility();
    });

    // 错误音选择
    $('#tip-error-select').on('change', function() {
        settings.errorSound = $(this).val();
        saveSettingsDebounced();
        initAudio();
        updateDeleteButtonVisibility();
    });

    // 音量滑块
    $('#tip-volume')
        .val(settings.volume * 100)
        .on('input', function() {
            const volume = $(this).val() / 100;
            settings.volume = volume;
            $('#tip-volume-value').text($(this).val());

            if (successSound) successSound.volume = volume;
            if (errorSound) errorSound.volume = volume;

            saveSettingsDebounced();
        });

    // 更新音量显示
    $('#tip-volume-value').text(Math.round(settings.volume * 100));

    // 测试按钮
    $('#tip-test-success').on('click', function() {
        playSuccessSound();
    });
    $('#tip-test-error').on('click', function() {
        playErrorSound();
    });

    // ========== 上传（仅本地文件） ==========
    function validateFile(file) {
        if (!file) return '未选择文件';
        const okType = file.type?.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(file.name || '');
        if (!okType) return '仅支持音频文件（mp3/wav/ogg/flac）';
        // 自定义音频以 base64 存入同步设置，体积过大会拖慢设置保存，限制为 5MB
        const max = 5 * 1024 * 1024; // 5MB
        if (file.size > max) return '文件过大（>5MB），自定义音频需跨设备同步，请使用较小的文件';
        return '';
    }

    async function afterAdd(kind, rec) {
        try {
            // 选中刚添加的项（仅本地IDB）
            const value = `idb:${rec.id}`;
            if (kind === 'success') {
                settings.successSound = value;
            } else {
                settings.errorSound = value;
            }
            saveSettingsDebounced();
            updateSelectOptions();
            initAudio();
            if (window.toastr) toastr.success('已添加并选中音频');
        } catch (e) {
            console.error(`[${extensionName}] 添加后处理失败:`, e);
        }
    }

    // 上传成功音
    $('#tip-upload-success').on('click', function() {
        $('#tip-file-success').val('').trigger('click');
    });
    $('#tip-file-success').on('change', async function() {
        const file = this.files && this.files[0];
        const msg = validateFile(file);
        if (msg) { if (window.toastr) toastr.error(msg); return; }
        try {
            const rec = await addCustomFile('success', file);
            await afterAdd('success', rec);
        } catch (e) {
            console.error(e);
            if (window.toastr) toastr.error('添加失败');
        }
    });

    // 上传错误音
    $('#tip-upload-error').on('click', function() {
        $('#tip-file-error').val('').trigger('click');
    });
    $('#tip-file-error').on('change', async function() {
        const file = this.files && this.files[0];
        const msg = validateFile(file);
        if (msg) { if (window.toastr) toastr.error(msg); return; }
        try {
            const rec = await addCustomFile('error', file);
            await afterAdd('error', rec);
        } catch (e) {
            console.error(e);
            if (window.toastr) toastr.error('添加失败');
        }
    });

    // ========== 删除自定义音效 ==========
    async function handleDelete(kind) {
        const val = kind === 'success' ? settings.successSound : settings.errorSound;

        // 检查是否是自定义音效
        if (!val || typeof val !== 'string' || !val.startsWith('idb:')) {
            if (window.toastr) toastr.warning('只能删除自定义音效');
            return;
        }

        const id = val.slice(4);
        const rec = getCustomById(kind, id);
        const name = rec?.name || '此音效';

        // 确认删除
        if (!confirm(`确定要删除「${name}」吗？此操作不可恢复。`)) {
            return;
        }

        try {
            await deleteCustomItem(id);

            // 清空当前选择
            if (kind === 'success') {
                settings.successSound = '';
            } else {
                settings.errorSound = '';
            }
            saveSettingsDebounced();
            updateSelectOptions();
            initAudio();

            if (window.toastr) toastr.success('已删除音效');
        } catch (e) {
            console.error(`[${extensionName}] 删除失败:`, e);
            if (window.toastr) toastr.error('删除失败');
        }
    }

    // 删除成功音效
    $('#tip-delete-success').on('click', function() {
        handleDelete('success');
    });

    // 删除错误音效
    $('#tip-delete-error').on('click', function() {
        handleDelete('error');
    });



    // 折叠面板功能
    $('#tip-header').off('click').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        const content = $('#tip-content');
        const icon = $(this).find('.inline-drawer-icon');

        if (content.is(':visible')) {
            content.slideUp(200);
            icon.removeClass('up').addClass('down');
        } else {
            content.slideDown(200);
            icon.removeClass('down').addClass('up');
        }
    });
}
