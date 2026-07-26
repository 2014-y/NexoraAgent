'use strict';

/**
 * Nexora Agent — 本地离线语音运行时（主进程）
 * - 设置持久化 nexora-voice.json
 * - TTS：优先 Piper CLI（若已下载），否则 Windows SAPI（离线可用）
 * - 本机 HTTP：供 voice-bridge 插件投递渠道 AI 回复朗读
 * - 单队列播放；静音清空队列；默认全部关闭不占性能
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    channelReplySpeak: false,
    wakeListen: false,
    voiceChat: false,
    desktopSpeak: true,
    muted: false,
    volume: 0.8,
    rate: 0,
    wakeWord: '你好 Nexora',
    activePackId: 'edge-yunyang',
    roleVoiceMap: {},
    httpPort: 18791,
    customPacks: []
});
const VOICE_PACKS = Object.freeze([
    {
        id: 'edge-yunyang',
        group: 'online',
        lang: 'zh',
        name: '云扬（在线·沉稳解说）',
        badgeKey: 'voice.badge.online',
        summary: '微软 Edge 在线神经男声，自然有语气；需联网，无需下载语音包。',
        size: '在线',
        engine: 'edge-online',
        edgeVoice: 'zh-CN-YunyangNeural',
        license: 'Microsoft Edge TTS',
        speakerId: 0,
        sapiHint: /zh|Chinese/i,
        rate: 0,
        online: true
    }
]);

// 内置音色：仅在线云扬
const MALE_VOICE_PACK_IDS = new Set([
    'edge-yunyang'
]);

function isOnlinePack(pack) {
    return !!(pack && (pack.online || pack.engine === 'edge-online'));
}

function clampVolume(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0.8;
    return Math.max(0, Math.min(1, n));
}

/**
 * 朗读噪音清洗（仅影响 TTS 文案，不改消息展示/发送）：
 * - emoji / 符号图标（避免念「交叉的剑」「齿轮」）
 * - MEDIA:、本地盘符路径、file/http(s) URL
 * - 工具状态英文尾巴
 * 不做过宽匹配，避免误删正常中英文内容。
 */
function stripEmojisForSpeech(text) {
    return String(text || '')
        .replace(/\p{Regional_Indicator}{2}/gu, '')
        .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu, '')
        .replace(/[\d#*]\uFE0F?\u20E3/g, '')
        .replace(/[\u2600-\u27BF\u2B00-\u2BFF]/g, '')
        .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
        .replace(/[\uFE0F\u200D\u20E3\uFE0E]/g, '');
}

function stripMediaPathsForSpeech(text) {
    return String(text || '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
        .replace(/<\/?(?:img|video|audio)\b[^>]*>/gi, ' ')
        // MEDIA: 整行（截图/生图指令，不应朗读）
        .replace(/(^|\n)\s*MEDIA\s*:\s*[^\n]*/gi, '$1')
        .replace(/\bMEDIA\s*:\s*/gi, ' ')
        // 协议 URL
        .replace(/\b(?:nexora-media|file|https?|ftp):\/\/[^\s)\]\"'<>]+/gi, ' ')
        // UNC
        .replace(/\\\\[^\s\n\"'<>\\]+(?:\\[^\s\n\"'<>\\]+)+/g, ' ')
        // Windows 盘符路径（C:\... / C:/...）
        .replace(/\b[A-Za-z]:\\[^\s\n\"'<>]+/g, ' ')
        .replace(/\b[A-Za-z]:\/[^\s\n\"'<>]+/g, ' ')
        // 常见 Unix 绝对路径
        .replace(/\/(?:Users|home|tmp|var|opt|mnt|media|root|Volumes|private)\/[^\s\n\"'<>]+/g, ' ')
        .replace(/\b(?:Screenshot captured|Image generated|Video generated|Media saved)\.?/gi, ' ')
        .replace(/\[\[(?:image|video|audio|media)\]\]/gi, ' ');
}

function sanitizeText(text, maxLen = 500) {
    let s = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/```[\s\S]*?```/g, ' ')
        // Markdown 链接保留可见文字
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#>*_`]/g, '');
    s = stripMediaPathsForSpeech(s);
    s = stripEmojisForSpeech(s)
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return '';
    if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
    return s;
}

function downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const getter = url.startsWith('https') ? https : http;
        const req = getter.get(url, {
            headers: { 'User-Agent': 'NexoraAgent/voice' },
            timeout: 120000
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
            let received = 0;
            res.on('data', (chunk) => {
                received += chunk.length;
                if (typeof onProgress === 'function' && total > 0) {
                    onProgress(Math.min(99, Math.round((received / total) * 100)), received, total);
                }
            });
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve({ received, total })));
        });
        req.on('timeout', () => {
            try { req.destroy(); } catch (e) {}
            try { file.close(); } catch (e) {}
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(new Error('download timeout'));
        });
        req.on('error', (err) => {
            try { file.close(); } catch (e) {}
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(err);
        });
    });
}

const ASR_MODEL_URLS = Object.freeze([
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2',
    // 国内直连 GitHub 失败时的镜像兜底（可随网络环境变化）
    'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2',
    'https://mirror.ghproxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2'
]);

function extractArchiveToDir(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(destDir, { recursive: true });
        const lower = String(archivePath || '').toLowerCase();
        let args;
        if (lower.endsWith('.zip') || lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
            args = ['-xf', archivePath, '-C', destDir];
        } else {
            // .tar.bz2 / .bz2
            args = ['-xjf', archivePath, '-C', destDir];
        }
        execFile('tar', args, { windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message || 'tar extract failed'));
            resolve(true);
        });
    });
}

function extractTarBz2(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(destDir, { recursive: true });
        execFile('tar', ['-xjf', archivePath, '-C', destDir], { windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error(stderr || err.message || 'tar extract failed'));
            }
            resolve(true);
        });
    });
}

class VoiceRuntime extends EventEmitter {
    constructor() {
        super();
        this._configDir = null;
        this._settings = { ...DEFAULT_SETTINGS };
        this._queue = [];
        this._speaking = false;
        this._currentProc = null;
        this._httpServer = null;
        this._status = 'idle'; // idle | listening_wake | listening | speaking | downloading
        this._downloadProgress = null;
        this._mainWindowGetter = null;
        this._sapiVoiceName = null;
        this._speakEpoch = 0;
        this._lastChannelSpeakAt = 0;
        this._lastChannelSpeakText = '';
        this._channelSpeakTimer = null;
        this._asrDownloadingPercent = null;
        this._asrRecognizer = null;
        this._sherpa = null;
    }

    init(opts) {
        this._configDir = opts.configDir;
        this._mainWindowGetter = opts.getMainWindow || null;
        fs.mkdirSync(this.packsDir, { recursive: true });
        fs.mkdirSync(this.tmpDir, { recursive: true });
        this._settings = this._readSettings();
        // 旧离线包已废弃：一律切到在线云扬（自定义包除外）
        const cur = this._settings.activePackId;
        const isCustom = !!(this._settings.customPacks || []).find((p) => p && p.id === cur);
        if (!isCustom && cur !== 'edge-yunyang') {
            this._settings.activePackId = 'edge-yunyang';
            try { this._writeSettings(); } catch (e) {}
        }
        this._syncHttpServer();
        this._emitStatus();
        return this.getPublicState();
    }

    get packsDir() {
        return path.join(this._configDir || process.cwd(), 'voice-packs');
    }

    get tmpDir() {
        return path.join(this.packsDir, '.tmp');
    }

    get settingsPath() {
        return path.join(this._configDir || process.cwd(), 'nexora-voice.json');
    }

    get asrModelDir() {
        return path.join(this.packsDir, 'asr-paraformer-zh');
    }

    _findAsrModelFiles() {
        // 1) 用户运行时目录（用户自行下载/导入的优先）
        let files = this._findAsrModelFilesInDir(this.asrModelDir);
        if (files) return files;
        // 2) 打包内置模型：随安装包 extraResources 落到 resources/builtin-asr（真实磁盘路径，native 可读，离线开箱可用）
        if (process.resourcesPath) {
            files = this._findAsrModelFilesInDir(path.join(process.resourcesPath, 'builtin-asr'));
            if (files) return files;
        }
        // 3) 开发态兜底：源码目录下的 builtin-asr
        return this._findAsrModelFilesInDir(path.join(__dirname, 'builtin-asr'));
    }

    _findAsrModelFilesInDir(dir) {
        if (!fs.existsSync(dir)) return null;
        let modelFile = null;
        let tokensFile = null;
        const stack = [dir];
        while (stack.length) {
            const cur = stack.pop();
            let entries = [];
            try { entries = fs.readdirSync(cur); } catch (e) { continue; }
            for (const name of entries) {
                const full = path.join(cur, name);
                let st;
                try { st = fs.statSync(full); } catch (e) { continue; }
                if (st.isDirectory()) {
                    stack.push(full);
                } else {
                    const lower = name.toLowerCase();
                    if (lower.endsWith('.onnx') && !lower.endsWith('.json')) {
                        if (!modelFile || lower.includes('int8') || st.size > fs.statSync(modelFile).size) {
                            modelFile = full;
                        }
                    } else if (lower === 'tokens.txt') {
                        tokensFile = full;
                    }
                }
            }
        }
        if (modelFile && tokensFile) {
            return { model: modelFile, tokens: tokensFile };
        }
        return null;
    }

    _loadSherpaOnnx() {
        if (this._sherpa) return this._sherpa;
        try {
            const nativeDir = path.dirname(require.resolve('sherpa-onnx-win-x64/package.json'));
            process.env.PATH = nativeDir + path.delimiter + (process.env.PATH || '');
        } catch (e) {}
        this._sherpa = require('sherpa-onnx-node');
        return this._sherpa;
    }

    getAsrState() {
        const files = this._findAsrModelFiles();
        return {
            installed: !!files,
            downloading: this._asrDownloadingPercent !== null,
            percent: this._asrDownloadingPercent || 0
        };
    }

    async downloadAsrModel() {
        if (this._asrDownloadingPercent !== null) {
            return { success: false, error: 'ASR model download already in progress' };
        }
        this._asrDownloadingPercent = 0;
        this._broadcast('voice-asr-state-updated', this.getAsrState());

        const archive = path.join(this.tmpDir, 'asr-paraformer-zh.tar.bz2');
        const destDir = this.asrModelDir;
        let lastError = null;

        try {
            fs.mkdirSync(this.tmpDir, { recursive: true });
            for (let i = 0; i < ASR_MODEL_URLS.length; i++) {
                const url = ASR_MODEL_URLS[i];
                try {
                    try { fs.unlinkSync(archive); } catch (e) {}
                    await downloadFile(url, archive, (percent) => {
                        this._asrDownloadingPercent = percent;
                        this._broadcast('voice-asr-state-updated', this.getAsrState());
                    });
                    lastError = null;
                    break;
                } catch (e) {
                    lastError = e;
                    console.warn('[VoiceRuntime] ASR download failed via', url, e && e.message);
                }
            }
            if (lastError) throw lastError;

            try {
                if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
            } catch (e) {}
            fs.mkdirSync(destDir, { recursive: true });
            await extractArchiveToDir(archive, destDir);
            try { fs.unlinkSync(archive); } catch (e) {}

            if (!this._findAsrModelFilesInDir(destDir)) {
                return { success: false, error: '下载完成但未找到有效模型（需含 .onnx 与 tokens.txt）' };
            }
            this._asrRecognizer = null;
            this._asrDownloadingPercent = null;
            this._broadcast('voice-asr-state-updated', this.getAsrState());
            return { success: true };
        } catch (e) {
            this._asrDownloadingPercent = null;
            try { fs.unlinkSync(archive); } catch (ex) {}
            this._broadcast('voice-asr-state-updated', this.getAsrState());
            return {
                success: false,
                error: (e.message || String(e)) + '。可改用「本地导入」选择已下载的 tar.bz2 / zip。'
            };
        }
    }

    /**
     * 本地导入离线 ASR：支持 tar.bz2 / zip / tar.gz，或已解压目录（含 .onnx + tokens.txt）
     */
    async importAsrModel(selectedPath) {
        try {
            if (!selectedPath || !fs.existsSync(selectedPath)) {
                return { success: false, error: '未选择有效文件或目录' };
            }
            const destDir = this.asrModelDir;
            const st = fs.statSync(selectedPath);
            const staging = path.join(this.tmpDir, 'asr-import-' + Date.now());
            try {
                if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
            } catch (e) {}
            fs.mkdirSync(staging, { recursive: true });

            if (st.isDirectory()) {
                fs.cpSync(selectedPath, staging, { recursive: true });
            } else {
                await extractArchiveToDir(selectedPath, staging);
            }

            const found = this._findAsrModelFilesInDir(staging);
            if (!found) {
                try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) {}
                return {
                    success: false,
                    error: '未找到有效 ASR 模型。请导入 sherpa-onnx-paraformer-zh 压缩包，或包含 .onnx 与 tokens.txt 的目录。'
                };
            }

            try {
                if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
            } catch (e) {}
            fs.mkdirSync(path.dirname(destDir), { recursive: true });
            fs.renameSync(staging, destDir);

            this._asrRecognizer = null;
            this._broadcast('voice-asr-state-updated', this.getAsrState());
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    async recognizeOffline(samples) {
        try {
            const files = this._findAsrModelFiles();
            if (!files) {
                return { success: false, error: 'ASR model not downloaded' };
            }
            const sherpa = this._loadSherpaOnnx();
            if (!this._asrRecognizer) {
                const config = {
                    featConfig: {
                        sampleRate: 16000,
                        featureDim: 80,
                    },
                    modelConfig: {
                        paraformer: {
                            model: files.model,
                        },
                        tokens: files.tokens,
                        numThreads: 2,
                        debug: false,
                        provider: 'cpu',
                    }
                };
                this._asrRecognizer = new sherpa.OfflineRecognizer(config);
            }
            const stream = this._asrRecognizer.createStream();
            const floatArray = Float32Array.from(samples);
            stream.acceptWaveform({ samples: floatArray, sampleRate: 16000 });
            await this._asrRecognizer.decodeAsync(stream);
            const result = this._asrRecognizer.getResult(stream);
            return { success: true, text: result.text || '' };
        } catch (e) {
            console.error('[VoiceRuntime] Offline ASR failed:', e);
            return { success: false, error: e.message || String(e) };
        }
    }

    getCatalog() {
        const customPacks = this._settings.customPacks || [];
        const builtins = VOICE_PACKS.filter((p) => MALE_VOICE_PACK_IDS.has(p.id));
        return [...builtins, ...customPacks].map((p) => ({
            ...p,
            installed: this.isPackInstalled(p.id),
            active: this._settings.activePackId === p.id
        }));
    }

    packMeta(id) {
        const customPacks = this._settings.customPacks || [];
        const pack = [...VOICE_PACKS, ...customPacks].find((p) => p.id === id);
        if (pack && !customPacks.includes(pack) && !MALE_VOICE_PACK_IDS.has(id)) return null;
        return pack || null;
    }

    packInstallDir(id) {
        try {
            if (process.resourcesPath) {
                const resDir = path.join(process.resourcesPath, 'voice-packs', id);
                if (fs.existsSync(resDir) && this._findOnnxModelInDir(resDir)) {
                    return resDir;
                }
            }
        } catch (e) {}
        return path.join(this.packsDir, id);
    }

    isPackInstalled(id) {
        const pack = this.packMeta(id);
        if (isOnlinePack(pack)) return true;
        // 有 .onnx 主模型才算真正可用（避免空目录被标成已下载）
        return !!this._findOnnxModel(id);
    }

    _readSettings() {
        try {
            if (!fs.existsSync(this.settingsPath)) return { ...DEFAULT_SETTINGS };
            const raw = fs.readFileSync(this.settingsPath, 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(raw);
            const activeId = parsed.activePackId;
            const activeOk = MALE_VOICE_PACK_IDS.has(activeId)
                || !!(parsed.customPacks || []).find((p) => p && p.id === activeId);
            return {
                ...DEFAULT_SETTINGS,
                ...parsed,
                activePackId: activeOk ? activeId : DEFAULT_SETTINGS.activePackId,
                volume: clampVolume(parsed.volume),
                roleVoiceMap: {}
            };
        } catch (e) {
            return { ...DEFAULT_SETTINGS };
        }
    }

    _writeSettings() {
        fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
        fs.writeFileSync(this.settingsPath, JSON.stringify(this._settings, null, 2), 'utf8');
    }

    getSettings() {
        return { ...this._settings };
    }

    _engineNote() {
        const activeId = this._settings.activePackId;
        const pack = this.packMeta(activeId);
        if (isOnlinePack(pack)) {
            return `当前在线神经音色：${(pack && pack.name) || activeId}（微软 Edge TTS，需联网）`;
        }
        if (activeId && this._findOnnxModel(activeId)) {
            return `当前离线神经引擎音色：${(pack && pack.name) || activeId}`;
        }
        return '当前音色未就绪：请选择「云扬（在线）」或下载离线语音包';
    }

    setSettings(patch) {
        const prev = { ...this._settings };
        const next = {
            ...this._settings,
            ...(patch && typeof patch === 'object' ? patch : {})
        };
        next.volume = clampVolume(next.volume);
        next.enabled = !!next.enabled;
        next.channelReplySpeak = !!next.channelReplySpeak;
        next.wakeListen = !!next.wakeListen;
        next.voiceChat = !!next.voiceChat;
        next.desktopSpeak = next.desktopSpeak !== false;
        next.muted = !!next.muted;
        if (typeof next.wakeWord === 'string' && next.wakeWord.trim()) {
            next.wakeWord = next.wakeWord.trim().slice(0, 40);
        } else {
            next.wakeWord = DEFAULT_SETTINGS.wakeWord;
        }
        if (!this.packMeta(next.activePackId)) next.activePackId = DEFAULT_SETTINGS.activePackId;
        // 所有角色统一使用全局男声，不再保留角色级音色覆盖。
        next.roleVoiceMap = {};

        // 总开关关闭时，停麦停播并释放队列
        if (!next.enabled) {
            next.wakeListen = false;
            this.stop({ clearQueue: true });
            this._setStatus('idle');
        }
        if (next.muted && !prev.muted) {
            this.stop({ clearQueue: true });
        }

        this._settings = next;
        this._writeSettings();
        this._syncHttpServer();
        this._emitStatus();
        this._broadcast('voice-settings-updated', this.getPublicState());
        return this.getPublicState();
    }

    getPublicState() {
        return {
            settings: this.getSettings(),
            status: this._status,
            speaking: this._speaking,
            queueLength: this._queue.length,
            downloadProgress: this._downloadProgress,
            catalog: this.getCatalog(),
            engineReady: true,
            engineNote: this._engineNote()
        };
    }

    _setStatus(status) {
        if (this._status === status) return;
        this._status = status;
        this._emitStatus();
    }

    setListenStatus(status) {
        if (!this._settings.enabled) {
            this._setStatus('idle');
            return;
        }
        if (status === 'listening_wake' || status === 'listening' || status === 'idle' || status === 'speaking') {
            // 朗读中保持 speaking 状态优先，不被监听状态覆盖
            if (!this._speaking) this._setStatus(status);
        }
    }

    _emitStatus() {
        this._broadcast('voice-status', this.getPublicState());
        this.emit('status', this.getPublicState());
    }

    _broadcast(channel, data) {
        try {
            const win = this._mainWindowGetter && this._mainWindowGetter();
            if (win && !win.isDestroyed() && win.webContents) {
                win.webContents.send(channel, data);
            }
        } catch (e) {}
    }

    _shouldSpeak(source) {
        if (source === 'preview') return true;
        const s = this._settings;
        if (!s.enabled || s.muted) return false;
        if (source === 'channel') return !!s.channelReplySpeak;
        if (source === 'desktop') return !!s.desktopSpeak || !!s.voiceChat;
        if (source === 'voice-chat') return !!s.voiceChat;
        return true;
    }

    speak(text, opts = {}) {
        const source = opts.source || 'manual';
        const requestedPackId = opts.packId || this._resolvePackId(opts.roleId);
        const packId = this.packMeta(requestedPackId)
            ? requestedPackId
            : (this._settings.activePackId || DEFAULT_SETTINGS.activePackId);
        // 长文先清洗再分段入队，避免一次塞太长导致卡顿
        const clean = sanitizeText(text, opts.maxLen || 800);
        if (!clean) return { success: false, error: 'empty' };
        
        const now = Date.now();
        if (this._lastSpeakText && clean && now - (this._lastSpeakAt || 0) < 15000) {
            // 仅拦截「几乎同一句」重复投递，避免长回复因开头相同被误丢
            const sameLen = Math.abs(clean.length - this._lastSpeakText.length) <= 12;
            const cmpLen = Math.min(50, Math.min(clean.length, this._lastSpeakText.length));
            if (sameLen && cmpLen > 5 && clean.slice(0, cmpLen) === this._lastSpeakText.slice(0, cmpLen)) {
                return { success: false, error: 'duplicate' };
            }
        }
        this._lastSpeakText = clean;
        this._lastSpeakAt = now;

        if (!this._shouldSpeak(source)) {
            return { success: false, error: this._settings.muted ? 'muted' : 'disabled' };
        }

        // 较大分片：减少 Edge 在线 TTS「合成→播放→再合成」之间的断句感
        const chunks = this._segmentText(clean, 480);
        for (const chunk of chunks) {
            this._queue.push({ text: chunk, packId, source });
        }
        this._pumpQueue();
        return { success: true, queued: this._queue.length };
    }

    _segmentText(text, maxChunk) {
        const s = String(text || '').trim();
        if (!s) return [];
        if (s.length <= maxChunk) return [s];
        const parts = [];
        const sentences = s.split(/(?<=[。！？!?；;.\n])/);
        let buf = '';
        for (const sentence of sentences) {
            const piece = sentence.trim();
            if (!piece) continue;
            if ((buf + piece).length > maxChunk && buf) {
                parts.push(buf.trim());
                buf = piece;
            } else {
                buf = (buf + piece).trim();
            }
        }
        if (buf) parts.push(buf.trim());
        // 仍过长则硬切
        const out = [];
        for (const p of parts) {
            if (p.length <= maxChunk) out.push(p);
            else {
                for (let i = 0; i < p.length; i += maxChunk) out.push(p.slice(i, i + maxChunk));
            }
        }
        return out.length ? out : [s.slice(0, maxChunk)];
    }

    _resolvePackId(roleId) {
        // 纯男声模式：所有角色、渠道和桌面回复统一使用当前全局男声。
        return this._settings.activePackId || DEFAULT_SETTINGS.activePackId;
    }

    stop(opts = {}) {
        // 抬世代号：正在合成/播放的链路见到过期号就立刻收工，避免杀进程后仍继续播下一段
        this._speakEpoch = (this._speakEpoch || 0) + 1;
        if (opts.clearQueue !== false) this._queue = [];
        if (this._currentProc) {
            const proc = this._currentProc;
            this._currentProc = null;
            try { proc.kill(); } catch (e) {}
            // Windows：尽量杀掉整棵子进程树（PowerShell MediaPlayer）
            try {
                if (process.platform === 'win32' && proc.pid) {
                    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
                        windowsHide: true,
                        stdio: 'ignore'
                    });
                }
            } catch (e) {}
        }
        this._speaking = false;
        this._restoreListenStatusAfterSpeak();
        return { success: true, interrupted: true };
    }

    _restoreListenStatusAfterSpeak() {
        if (!this._settings.enabled) {
            this._setStatus('idle');
            return;
        }
        if (this._settings.wakeListen) this._setStatus('listening_wake');
        else if (this._settings.voiceChat) this._setStatus('listening');
        else this._setStatus('idle');
    }

    async _pumpQueue() {
        if (this._speaking) return;
        if (!this._queue.length) {
            this._restoreListenStatusAfterSpeak();
            return;
        }
        if (this._settings.muted) {
            this._queue = [];
            this._restoreListenStatusAfterSpeak();
            return;
        }

        const job = this._queue.shift();
        const jobEpoch = this._speakEpoch;
        this._speaking = true;
        this._setStatus('speaking');
        try {
            // 看门狗：任一朗读任务超过 130s 仍未结束(如损坏音频/卡死的播放进程)，强杀并继续队列，
            // 防止 _speaking 永久为 true 导致之后所有语音都发不出。
            await Promise.race([
                this._speakJob(job),
                new Promise((resolve) => setTimeout(() => {
                    try { if (this._currentProc) this._currentProc.kill(); } catch (_) {}
                    console.warn('[VoiceRuntime] speak watchdog fired — killed stuck playback');
                    resolve();
                }, 130000))
            ]);
        } catch (e) {
            console.warn('[VoiceRuntime] speak failed:', e && e.message);
        } finally {
            // stop() 会抬 epoch；过期任务不得清掉新任务的 speaking，也不得续播空队列
            if (jobEpoch !== this._speakEpoch) return;
            this._speaking = false;
            this._currentProc = null;
            setImmediate(() => this._pumpQueue());
        }
    }

    async _speakJob(job) {
        const pack = this.packMeta(job.packId) || this.packMeta(DEFAULT_SETTINGS.activePackId);
        const volume = Math.round(clampVolume(this._settings.volume) * 100);

        // 1) 微软 Edge 在线神经 TTS（云扬等）
        if (isOnlinePack(pack)) {
            await this._speakWithEdgeOnline(job, pack, volume);
            return;
        }

        const modelPath = this._findOnnxModel(job.packId);

        // 2) sherpa-onnx 离线引擎
        if (modelPath) {
            let sherpaErr = null;
            const ok = await this._speakWithSherpa(job, pack, volume).catch((e) => {
                sherpaErr = e;
                console.warn('[VoiceRuntime] sherpa tts failed:', e && e.message);
                return false;
            });
            if (ok) return;
            this._broadcast('voice-speak-error', {
                packId: job.packId,
                packName: pack && pack.name,
                error: (sherpaErr && sherpaErr.message) || 'neural tts failed',
                hint: 'neural_failed_no_sapi_fallback'
            });
            throw sherpaErr || new Error('neural tts failed');
        }

        // 3) 兼容手动放置的 piper.exe
        const piperBin = this._findPiperBinary();
        if (piperBin && modelPath) {
            await this._speakWithPiper(piperBin, modelPath, job.text, volume, pack);
            return;
        }

        this._broadcast('voice-speak-error', {
            packId: job.packId,
            packName: pack && pack.name,
            error: 'pack_not_installed',
            hint: 'male_pack_required'
        });
        throw new Error('male voice pack not installed');
    }

    /** 微软 Edge 在线神经 TTS → mp3 → 播放 */
    async _speakWithEdgeOnline(job, pack, volume) {
        const epoch = this._speakEpoch;
        const voice = (pack && pack.edgeVoice) || 'zh-CN-YunyangNeural';
        const userRate = typeof this._settings.rate === 'number' ? this._settings.rate : 0;
        const packRate = pack && typeof pack.rate === 'number' ? pack.rate : 0;
        const ratePct = Math.max(-50, Math.min(50, (packRate + userRate) * 5));
        const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
        const volPct = Math.max(0, Math.min(100, volume));

        fs.mkdirSync(this.tmpDir, { recursive: true });
        const mp3Path = path.join(this.tmpDir, `edge-tts-${Date.now()}.mp3`);

        let synthesized = false;
        // 1) 优先 Node msedge-tts
        try {
            const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
            if (epoch === this._speakEpoch) {
                const tts = new MsEdgeTTS();
                await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
                if (epoch === this._speakEpoch) {
                    await tts.toFile(mp3Path, job.text, { rate: rateStr, volume: String(volPct) });
                    synthesized = fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1000;
                }
                try { tts.close(); } catch (e) {}
            }
        } catch (e) {
            console.warn('[VoiceRuntime] msedge-tts failed, fallback python:', e && e.message);
        }

        // 2) 回退：本机 python -m edge_tts（国内更稳）
        if (!synthesized && epoch === this._speakEpoch) {
            await this._synthEdgeWithPython(job.text, voice, rateStr, mp3Path, epoch);
            synthesized = fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1000;
        }

        if (epoch !== this._speakEpoch) {
            try { fs.unlinkSync(mp3Path); } catch (e) {}
            return;
        }
        if (!synthesized) {
            throw new Error('在线云扬 TTS 合成失败（请检查网络，或安装: pip install edge-tts）');
        }

        try {
            await this._playWav(mp3Path, volume, epoch);
        } finally {
            try { fs.unlinkSync(mp3Path); } catch (e) {}
        }
    }

    _synthEdgeWithPython(text, voice, rateStr, mp3Path, epoch) {
        return new Promise((resolve, reject) => {
            if (epoch !== this._speakEpoch) return resolve(false);
            const textFile = path.join(this.tmpDir, `edge-text-${Date.now()}.txt`);
            try {
                fs.writeFileSync(textFile, text, 'utf8');
            } catch (e) {
                return reject(e);
            }
            const pyCandidates = ['python', 'py'];
            const tryNext = (idx) => {
                if (idx >= pyCandidates.length) {
                    try { fs.unlinkSync(textFile); } catch (e) {}
                    return reject(new Error('未找到 python，无法使用 edge-tts'));
                }
                const bin = pyCandidates[idx];
                const args = bin === 'py'
                    ? ['-3', '-m', 'edge_tts', '--voice', voice, '--rate', rateStr, '--file', textFile, '--write-media', mp3Path]
                    : ['-m', 'edge_tts', '--voice', voice, '--rate', rateStr, '--file', textFile, '--write-media', mp3Path];
                const proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
                this._currentProc = proc;
                let err = '';
                proc.stderr.on('data', (d) => { err += d.toString(); });
                proc.on('error', () => tryNext(idx + 1));
                proc.on('close', (code) => {
                    try { fs.unlinkSync(textFile); } catch (e) {}
                    if (epoch !== this._speakEpoch) return resolve(false);
                    if (code === 0 && fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1000) {
                        return resolve(true);
                    }
                    if (idx + 1 < pyCandidates.length) return tryNext(idx + 1);
                    reject(new Error(err.slice(0, 300) || 'python edge-tts failed'));
                });
            };
            tryNext(0);
        });
    }

    /** 通过子进程运行 sherpa-onnx 合成 wav 后播放；返回是否成功 */
    _speakWithSherpa(job, pack, volume) {
        return new Promise((resolve, reject) => {
            const epoch = this._speakEpoch;
            let workerPath = path.join(__dirname, 'tts-worker.js');
            // 打包后 asar 内脚本无法被子进程直接执行，切到 unpacked 路径
            if (workerPath.includes('app.asar') && !workerPath.includes('app.asar.unpacked')) {
                const unpacked = workerPath.replace('app.asar', 'app.asar.unpacked');
                if (fs.existsSync(unpacked)) workerPath = unpacked;
            }
            if (!fs.existsSync(workerPath)) return resolve(false);

            const textFile = path.join(this.tmpDir, `tts-text-${Date.now()}.txt`);
            const wavPath = path.join(this.tmpDir, `tts-${Date.now()}.wav`);
            fs.mkdirSync(this.tmpDir, { recursive: true });
            fs.writeFileSync(textFile, job.text, 'utf8');

            // pack.rate(-10..10) 映射到语速 speed（1 为原速）
            const packRate = pack && typeof pack.rate === 'number' ? pack.rate : 0;
            const userRate = typeof this._settings.rate === 'number' ? this._settings.rate : 0;
            const speed = Math.max(0.6, Math.min(1.6, 1 + (packRate + userRate) * 0.05));
            const sid = pack && typeof pack.speakerId === 'number' ? pack.speakerId : 0;

            const proc = spawn(process.execPath, [
                workerPath,
                '--model-dir', this.packInstallDir(job.packId),
                '--text-file', textFile,
                '--out', wavPath,
                '--sid', String(sid),
                '--speed', String(speed)
            ], {
                windowsHide: true,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            this._currentProc = proc;

            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });
            proc.on('error', (err) => {
                try { fs.unlinkSync(textFile); } catch (e) {}
                if (epoch !== this._speakEpoch) return resolve(true);
                reject(err);
            });
            proc.on('close', () => {
                try { fs.unlinkSync(textFile); } catch (e) {}
                if (epoch !== this._speakEpoch) {
                    try { fs.unlinkSync(wavPath); } catch (e) {}
                    return resolve(true); // 已被打断，不算失败
                }
                let result = null;
                try { result = JSON.parse(stdout.trim().split('\n').pop()); } catch (e) {}
                if (!result || !result.ok || !fs.existsSync(wavPath)) {
                    return reject(new Error((result && result.error) || stderr.slice(0, 300) || 'sherpa worker failed'));
                }
                this._playWav(wavPath, volume, epoch).then(() => {
                    try { fs.unlinkSync(wavPath); } catch (e) {}
                    resolve(true);
                }, (err) => {
                    try { fs.unlinkSync(wavPath); } catch (e) {}
                    if (epoch !== this._speakEpoch) return resolve(true);
                    reject(err);
                });
            });
        });
    }

    _findPiperBinary() {
        const candidates = [
            path.join(this.packsDir, 'bin', 'piper.exe'),
            path.join(this.packsDir, 'bin', 'piper'),
            path.join(this.packsDir, 'piper.exe')
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
        return null;
    }

    _findOnnxModelInDir(dir) {
        if (!dir || !fs.existsSync(dir)) return null;
        const stack = [dir];
        while (stack.length) {
            const cur = stack.pop();
            let entries = [];
            try { entries = fs.readdirSync(cur); } catch (e) { continue; }
            for (const name of entries) {
                const full = path.join(cur, name);
                let st;
                try { st = fs.statSync(full); } catch (e) { continue; }
                if (st.isDirectory()) stack.push(full);
                else if (/\.onnx$/i.test(name) && !/\.json$/i.test(name)) return full;
            }
        }
        return null;
    }

    _findOnnxModel(packId) {
        const dir = this.packInstallDir(packId);
        return this._findOnnxModelInDir(dir);
    }

    _speakWithPiper(bin, model, text, volume, pack) {
        return new Promise((resolve, reject) => {
            const epoch = this._speakEpoch;
            const packRate = pack && typeof pack.rate === 'number' ? pack.rate : 0;
            const userRate = typeof this._settings.rate === 'number' ? this._settings.rate : 0;
            const totalRate = packRate + userRate;
            const lengthScale = Math.max(0.5, Math.min(2.0, 1.0 - totalRate * 0.05));

            const wavPath = path.join(this.tmpDir, `tts-${Date.now()}.wav`);
            const proc = spawn(bin, ['--model', model, '--output_file', wavPath, '--length_scale', String(lengthScale)], {
                windowsHide: true,
                stdio: ['pipe', 'ignore', 'pipe']
            });
            this._currentProc = proc;
            proc.stdin.write(text, 'utf8');
            proc.stdin.end();
            proc.on('error', (err) => {
                if (epoch !== this._speakEpoch) return resolve();
                reject(err);
            });
            proc.on('close', (code) => {
                if (epoch !== this._speakEpoch) {
                    try { fs.unlinkSync(wavPath); } catch (e) {}
                    return resolve();
                }
                if (code !== 0 || !fs.existsSync(wavPath)) {
                    return this._speakWithSapi(text, volume, 0, null).then(resolve, reject);
                }
                this._playWav(wavPath, volume, epoch).then(() => {
                    try { fs.unlinkSync(wavPath); } catch (e) {}
                    resolve();
                }, reject);
            });
        });
    }

    _playWav(wavPath, volume, epoch) {
        const speakEpoch = typeof epoch === 'number' ? epoch : this._speakEpoch;
        return new Promise((resolve, reject) => {
            if (speakEpoch !== this._speakEpoch) return resolve();
            const attach = (proc, onError) => {
                this._currentProc = proc;
                proc.on('error', (err) => {
                    if (speakEpoch !== this._speakEpoch) return resolve();
                    if (onError) return onError(err);
                    reject(err);
                });
                proc.on('close', () => resolve());
            };
            if (process.platform === 'darwin') {
                attach(spawn('afplay', ['-v', String(Math.max(0, Math.min(1, volume / 100))), wavPath], { stdio: 'ignore' }));
                return;
            }
            if (process.platform !== 'win32') {
                // linux：优先 PulseAudio 的 paplay，缺失时回退 ALSA aplay
                const vol = Math.round(Math.max(0, Math.min(1, volume / 100)) * 65536);
                attach(spawn('paplay', [`--volume=${vol}`, wavPath], { stdio: 'ignore' }), () => {
                    attach(spawn('aplay', ['-q', wavPath], { stdio: 'ignore' }));
                });
                return;
            }
            const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]'${wavPath.replace(/'/g, "''")}')
$p.Volume = ${Math.max(0, Math.min(1, volume / 100))}
$p.Play()
Start-Sleep -Milliseconds 80
# 墙钟上限：损坏/无时长的音频不会让 NaturalDuration 永远解析不出，最多等 3 秒
$waited = 0
while ($p.NaturalDuration.HasTimeSpan -eq $false -and $waited -lt 3000) { Start-Sleep -Milliseconds 40; $waited += 40 }
if ($p.NaturalDuration.HasTimeSpan) { $ms = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds } else { $ms = 8000 }
if ($ms -lt 100) { $ms = 100 }
if ($ms -gt 120000) { $ms = 120000 }
Start-Sleep -Milliseconds ($ms + 40)
$p.Close()
`;
            attach(spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', ps], {
                windowsHide: true,
                stdio: 'ignore'
            }));
        });
    }

    _speakWithSapi(text, volume, rate, pack) {
        return new Promise((resolve, reject) => {
            const safe = String(text).replace(/'/g, "''");
            const hint = pack && pack.sapiHint ? String(pack.sapiHint) : '';
            const ps = `
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.Volume = ${Math.max(0, Math.min(100, volume | 0))}
  $userRate = ${typeof this._settings.rate === 'number' ? this._settings.rate : 0}
  $synth.Rate = ${Math.max(-10, Math.min(10, (rate | 0) + $userRate))}
  $hint = '${hint.replace(/'/g, "''")}'
  if ($hint) {
    $voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
    $pick = $voices | Where-Object { $_.Name -match $hint -or $_.Culture.Name -match $hint } | Select-Object -First 1
    if ($pick) { $synth.SelectVoice($pick.Name) }
  }
  $synth.Speak('${safe}')
  $synth.Dispose()
} catch {}
`;
            const proc = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', ps], {
                windowsHide: true,
                stdio: 'ignore'
            });
            this._currentProc = proc;
            proc.on('error', reject);
            proc.on('close', () => resolve());
        });
    }

    async downloadPack(packId, onProgress) {
        const pack = this.packMeta(packId);
        if (!pack) return { success: false, error: 'unknown pack' };
        if (isOnlinePack(pack)) return { success: true, path: null, online: true };
        if (!pack.downloadUrl) return { success: false, error: 'no download url' };

        this._downloadProgress = { packId, percent: 0 };
        this._setStatus('downloading');
        this._broadcast('voice-download-progress', this._downloadProgress);

        const destDir = this.packInstallDir(packId);
        const archive = path.join(this.tmpDir, `${packId}.tar.bz2`);
        fs.mkdirSync(this.tmpDir, { recursive: true });

        try {
            await downloadFile(pack.downloadUrl, archive, (percent) => {
                this._downloadProgress = { packId, percent };
                if (typeof onProgress === 'function') onProgress(percent);
                this._broadcast('voice-download-progress', this._downloadProgress);
            });
            fs.mkdirSync(destDir, { recursive: true });
            await extractTarBz2(archive, destDir);
            fs.writeFileSync(path.join(destDir, 'pack.json'), JSON.stringify({
                id: pack.id,
                name: pack.name,
                downloadedAt: new Date().toISOString(),
                sourceUrl: pack.sourceUrl,
                downloadUrl: pack.downloadUrl
            }, null, 2), 'utf8');
            try { fs.unlinkSync(archive); } catch (e) {}
            this._downloadProgress = { packId, percent: 100 };
            this._broadcast('voice-download-progress', this._downloadProgress);
            this._setStatus(this._settings.wakeListen && this._settings.enabled ? 'listening_wake' : 'idle');
            this._broadcast('voice-settings-updated', this.getPublicState());
            return { success: true, path: destDir };
        } catch (e) {
            this._downloadProgress = null;
            this._setStatus('idle');
            return { success: false, error: e && e.message ? e.message : String(e) };
        }
    }

    async importCustomPack(archivePath) {
        try {
            const packId = 'custom-' + Date.now();
            const destDir = this.packInstallDir(packId);
            fs.mkdirSync(destDir, { recursive: true });

            await new Promise((resolve, reject) => {
                if (archivePath.endsWith('.zip')) {
                    execFile('tar', ['-xf', archivePath, '-C', destDir], { windowsHide: true }, (err, stdout, stderr) => {
                        if (err) return reject(new Error(stderr || err.message || 'tar extract failed'));
                        resolve();
                    });
                } else {
                    execFile('tar', ['-xjf', archivePath, '-C', destDir], { windowsHide: true }, (err, stdout, stderr) => {
                        if (err) return reject(new Error(stderr || err.message || 'tar extract failed'));
                        resolve();
                    });
                }
            });

            const onnxModel = this._findOnnxModel(packId);
            if (!onnxModel) {
                fs.rmSync(destDir, { recursive: true, force: true });
                return { success: false, error: '解压后未找到 .onnx 模型文件' };
            }

            const fileName = path.basename(archivePath);
            const customPack = {
                id: packId,
                group: 'zh',
                lang: 'zh',
                name: fileName.replace(/\.(tar\.bz2|zip|tar\.gz)$/i, ''),
                badgeKey: 'voice.badge.zh',
                summary: '导入的自定义语音模型包。',
                size: '本地',
                engine: 'sherpa-onnx（离线自定义）',
                license: '自定义',
                speakerId: 0,
                sapiHint: /zh/i,
                rate: 0
            };

            if (!this._settings.customPacks) this._settings.customPacks = [];
            this._settings.customPacks.push(customPack);
            this._writeSettings();
            
            this._broadcast('voice-settings-updated', this.getPublicState());
            return { success: true, packId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async deleteCustomPack(packId) {
        if (!this._settings.customPacks) return { success: false, error: 'No custom packs found' };
        const index = this._settings.customPacks.findIndex(p => p.id === packId);
        if (index === -1) return { success: false, error: 'Pack not found' };
        
        // Check if it's the active pack
        if (this._settings.activePackId === packId) {
            this._settings.activePackId = null;
        }

        // Remove from settings
        this._settings.customPacks.splice(index, 1);
        this._writeSettings();

        // Delete files
        const destDir = this.packInstallDir(packId);
        try {
            if (fs.existsSync(destDir)) {
                fs.rmSync(destDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.error(`Failed to delete pack directory ${destDir}:`, e);
        }

        this._broadcast('voice-settings-updated', this.getPublicState());
        return { success: true };
    }

    bindRoleVoice(roleId, packId) {
        if (!roleId) return this.getPublicState();
        if (!this._settings.roleVoiceMap) this._settings.roleVoiceMap = {};
        if (!packId) delete this._settings.roleVoiceMap[roleId];
        else if (this.packMeta(packId)) this._settings.roleVoiceMap[roleId] = packId;
        this._writeSettings();
        this._broadcast('voice-settings-updated', this.getPublicState());
        return this.getPublicState();
    }

    _syncHttpServer() {
        const want = !!(this._settings.enabled && this._settings.channelReplySpeak);
        if (!want) {
            this._stopHttpServer();
            return;
        }
        if (this._httpServer) return;
        const port = Number(this._settings.httpPort) || DEFAULT_SETTINGS.httpPort;
        const server = http.createServer((req, res) => {
            this._handleHttp(req, res);
        });
        server.on('error', (err) => {
            console.warn('[VoiceRuntime] HTTP server error:', err && err.message);
            this._httpServer = null;
        });
        server.listen(port, '127.0.0.1', () => {
            console.log(`[VoiceRuntime] HTTP listening 127.0.0.1:${port}`);
        });
        this._httpServer = server;
    }

    _stopHttpServer() {
        if (!this._httpServer) return;
        try { this._httpServer.close(); } catch (e) {}
        this._httpServer = null;
    }

    _handleHttp(req, res) {
        const send = (code, obj) => {
            const body = JSON.stringify(obj);
            res.writeHead(code, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body)
            });
            res.end(body);
        };

        if (req.method === 'GET' && (req.url === '/voice/status' || req.url === '/status')) {
            return send(200, this.getPublicState());
        }

        if (req.method === 'POST' && (req.url === '/voice/speak' || req.url === '/speak')) {
            let raw = '';
            req.on('data', (c) => {
                raw += c;
                if (raw.length > 200000) req.destroy();
            });
            req.on('end', () => {
                try {
                    const payload = raw ? JSON.parse(raw) : {};
                    const text = payload.text || payload.content || '';
                    const result = this.speak(text, {
                        source: payload.source || 'channel',
                        roleId: payload.roleId,
                        packId: payload.packId,
                        maxLen: payload.maxLen || 500
                    });
                    send(200, result);
                } catch (e) {
                    send(400, { success: false, error: e.message });
                }
            });
            return;
        }

        if (req.method === 'POST' && (req.url === '/voice/stop' || req.url === '/stop')) {
            send(200, this.stop({ clearQueue: true }));
            return;
        }

        send(404, { success: false, error: 'not found' });
    }

    /**
     * 网关插件钩子偶发未加载时的兜底：从 gateway stdout 识别渠道回复完成，
     * 再读最新会话里的助手文本并朗读。
     */
    maybeSpeakChannelReplyFromGatewayLog(logText) {
        try {
            if (!this._settings || !this._settings.enabled || !this._settings.channelReplySpeak || this._settings.muted) {
                return;
            }
            const t = String(logText || '');
            // 旧版 OpenClaw 信号 + 微信/渠道实际出站成功日志
            const hit =
                /Closed streaming|dispatch complete \(queuedFinal=true, replies=[1-9]/i.test(t) ||
                /outbound:\s*text sent OK/i.test(t) ||
                /\[feishu\].*(?:message sent|sent successfully|reply sent)/i.test(t) ||
                /\[qqbot\].*(?:message sent|sent OK|reply sent|send.*success)/i.test(t);
            if (!hit) return;
            if (/outbound:\s*cancelled/i.test(t)) return;
            if (this._channelSpeakTimer) clearTimeout(this._channelSpeakTimer);
            this._channelSpeakTimer = setTimeout(() => {
                this._channelSpeakTimer = null;
                this._speakLatestAssistantFromSessions();
            }, 700);
        } catch (e) {}
    }

    _speakLatestAssistantFromSessions() {
        try {
            if (!this._settings.enabled || !this._settings.channelReplySpeak || this._settings.muted) return;
            const sessionsDir = path.join(this._configDir || '', 'agents', 'main', 'sessions');
            if (!sessionsDir || !fs.existsSync(sessionsDir)) return;
            const files = fs.readdirSync(sessionsDir)
                .filter((name) => name.endsWith('.jsonl') && !name.includes('.trajectory.'))
                .map((name) => {
                    const full = path.join(sessionsDir, name);
                    let mtime = 0;
                    try { mtime = fs.statSync(full).mtimeMs; } catch (e) {}
                    return { full, mtime };
                })
                .sort((a, b) => b.mtime - a.mtime);
            if (!files.length) return;

            const lines = fs.readFileSync(files[0].full, 'utf8').trim().split('\n');
            let text = '';
            for (let i = lines.length - 1; i >= 0; i -= 1) {
                try {
                    const row = JSON.parse(lines[i]);
                    if (row.type !== 'message' || !row.message || row.message.role !== 'assistant') continue;
                    const content = row.message.content;
                    if (typeof content === 'string') text = content;
                    else if (Array.isArray(content)) {
                        text = content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
                    }
                    if (text && text.trim()) break;
                } catch (e) {}
            }
            text = sanitizeText(text, 500);
            if (!text || text === 'HEARTBEAT_OK' || text.length < 2) return;
            const now = Date.now();
            if (text === this._lastChannelSpeakText && now - this._lastChannelSpeakAt < 12000) return;
            this._lastChannelSpeakText = text;
            this._lastChannelSpeakAt = now;
            console.log('[VoiceRuntime] channel-reply speak:', text.slice(0, 60));
            this.speak(text, { source: 'channel', maxLen: 500 });
        } catch (e) {
            console.warn('[VoiceRuntime] channel-reply speak failed:', e && e.message);
        }
    }

    dispose() {
        if (this._channelSpeakTimer) {
            try { clearTimeout(this._channelSpeakTimer); } catch (e) {}
            this._channelSpeakTimer = null;
        }
        this.stop({ clearQueue: true });
        this._stopHttpServer();
    }
}

const voiceRuntime = new VoiceRuntime();

module.exports = {
    voiceRuntime,
    DEFAULT_SETTINGS,
    VOICE_PACKS,
    sanitizeText
};
