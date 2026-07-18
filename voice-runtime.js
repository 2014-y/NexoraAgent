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
    activePackId: 'piper-zh-chaowen',
    roleVoiceMap: {},
    httpPort: 18791,
    customPacks: []
});
const VOICE_PACKS = Object.freeze([
    {
        id: 'fanchen-wnj-zh-en',
        group: 'jarvis',
        lang: 'zh',
        name: 'Nexora Agent',
        badgeKey: 'voice.badge.jarvis',
        summary: '高质量男声音色，支持中英双语混合朗读。',
        size: '~116 MB',
        engine: 'sherpa-onnx（离线）',
        license: '开源（fanchen）',
        speakerId: 0,
        sapiHint: /zh|Chinese|en|English/i,
        rate: 0,
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-fanchen-wnj.tar.bz2',
        sourceUrl: 'https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese/vits-zh-hf-fanchen-wnj.html'
    }
]);

// 仅展示保留的默认语音包，其他旧包将从 UI 列表中隐藏
const MALE_VOICE_PACK_IDS = new Set([
    'fanchen-wnj-zh-en'
]);

function clampVolume(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0.8;
    return Math.max(0, Math.min(1, n));
}

function sanitizeText(text, maxLen = 500) {
    let s = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#>*_`]/g, '')
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
        const req = getter.get(url, { headers: { 'User-Agent': 'NexoraAgent/voice' } }, (res) => {
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
        req.on('error', (err) => {
            try { file.close(); } catch (e) {}
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(err);
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
        const dir = this.asrModelDir;
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

        const url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2';
        const archive = path.join(this.tmpDir, 'asr-paraformer-zh.tar.bz2');
        const destDir = this.asrModelDir;

        try {
            fs.mkdirSync(this.tmpDir, { recursive: true });
            await downloadFile(url, archive, (percent) => {
                this._asrDownloadingPercent = percent;
                this._broadcast('voice-asr-state-updated', this.getAsrState());
            });
            fs.mkdirSync(destDir, { recursive: true });
            await extractTarBz2(archive, destDir);
            try { fs.unlinkSync(archive); } catch (e) {}
            this._asrDownloadingPercent = null;
            this._broadcast('voice-asr-state-updated', this.getAsrState());
            return { success: true };
        } catch (e) {
            this._asrDownloadingPercent = null;
            try { fs.unlinkSync(archive); } catch (ex) {}
            this._broadcast('voice-asr-state-updated', this.getAsrState());
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
        return path.join(this.packsDir, id);
    }

    isPackInstalled(id) {
        // 有 .onnx 主模型才算真正可用（避免空目录被标成已下载）
        return !!this._findOnnxModel(id);
    }

    _readSettings() {
        try {
            if (!fs.existsSync(this.settingsPath)) return { ...DEFAULT_SETTINGS };
            const raw = fs.readFileSync(this.settingsPath, 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(raw);
            return {
                ...DEFAULT_SETTINGS,
                ...parsed,
                activePackId: MALE_VOICE_PACK_IDS.has(parsed.activePackId)
                    ? parsed.activePackId
                    : DEFAULT_SETTINGS.activePackId,
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
        if (activeId && this._findOnnxModel(activeId)) {
            return `当前神经引擎音色：${(pack && pack.name) || activeId}`;
        }
        return '当前男声音色未下载：不会使用系统女声。请点对应卡片「下载语音包」';
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
            // Check for prefix match to handle truncation differences (e.g. 500 vs 800)
            const cmpLen = Math.min(50, Math.min(clean.length, this._lastSpeakText.length));
            if (cmpLen > 5 && clean.slice(0, cmpLen) === this._lastSpeakText.slice(0, cmpLen)) {
                return { success: false, error: 'duplicate' };
            }
        }
        this._lastSpeakText = clean;
        this._lastSpeakAt = now;

        if (!this._shouldSpeak(source)) {
            return { success: false, error: this._settings.muted ? 'muted' : 'disabled' };
        }

        const chunks = this._segmentText(clean, 180);
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
        if (opts.clearQueue !== false) this._queue = [];
        if (this._currentProc) {
            try { this._currentProc.kill(); } catch (e) {}
            this._currentProc = null;
        }
        this._speaking = false;
        if (!this._settings.enabled) this._setStatus('idle');
        else if (this._settings.wakeListen) this._setStatus('listening_wake');
        else this._setStatus('idle');
        return { success: true };
    }

    async _pumpQueue() {
        if (this._speaking) return;
        if (!this._queue.length) {
            if (this._settings.enabled && this._settings.wakeListen) this._setStatus('listening_wake');
            else this._setStatus('idle');
            return;
        }
        if (this._settings.muted) {
            this._queue = [];
            this._setStatus(this._settings.wakeListen && this._settings.enabled ? 'listening_wake' : 'idle');
            return;
        }

        const job = this._queue.shift();
        this._speaking = true;
        this._setStatus('speaking');
        try {
            await this._speakJob(job);
        } catch (e) {
            console.warn('[VoiceRuntime] speak failed:', e && e.message);
        } finally {
            this._speaking = false;
            this._currentProc = null;
            setImmediate(() => this._pumpQueue());
        }
    }

    async _speakJob(job) {
        const pack = this.packMeta(job.packId) || this.packMeta(DEFAULT_SETTINGS.activePackId);
        const volume = Math.round(clampVolume(this._settings.volume) * 100);
        const rate = pack && typeof pack.rate === 'number' ? pack.rate : 0;

        const modelPath = this._findOnnxModel(job.packId);

        // 1) sherpa-onnx 神经引擎（模型已下载时），真正区分男女声
        if (modelPath) {
            let sherpaErr = null;
            const ok = await this._speakWithSherpa(job, pack, volume).catch((e) => {
                sherpaErr = e;
                console.warn('[VoiceRuntime] sherpa tts failed:', e && e.message);
                return false;
            });
            if (ok) return;
            // 已下载的神经音色失败时，不再静默回退到系统女声（否则听起来像「全是女音」）
            this._broadcast('voice-speak-error', {
                packId: job.packId,
                packName: pack && pack.name,
                error: (sherpaErr && sherpaErr.message) || 'neural tts failed',
                hint: 'neural_failed_no_sapi_fallback'
            });
            throw sherpaErr || new Error('neural tts failed');
        }

        // 2) 兼容手动放置的 piper.exe
        const piperBin = this._findPiperBinary();
        if (piperBin && modelPath) {
            await this._speakWithPiper(piperBin, modelPath, job.text, volume, pack);
            return;
        }

        // 3) 纯男声模式不允许回退到本机 Windows 女声。
        this._broadcast('voice-speak-error', {
            packId: job.packId,
            packName: pack && pack.name,
            error: 'pack_not_installed',
            hint: 'male_pack_required'
        });
        throw new Error('male voice pack not installed');
    }

    /** 通过子进程运行 sherpa-onnx 合成 wav 后播放；返回是否成功 */
    _speakWithSherpa(job, pack, volume) {
        return new Promise((resolve, reject) => {
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
                reject(err);
            });
            proc.on('close', () => {
                try { fs.unlinkSync(textFile); } catch (e) {}
                let result = null;
                try { result = JSON.parse(stdout.trim().split('\n').pop()); } catch (e) {}
                if (!result || !result.ok || !fs.existsSync(wavPath)) {
                    return reject(new Error((result && result.error) || stderr.slice(0, 300) || 'sherpa worker failed'));
                }
                this._playWav(wavPath, volume).then(() => {
                    try { fs.unlinkSync(wavPath); } catch (e) {}
                    resolve(true);
                }, reject);
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

    _findOnnxModel(packId) {
        const dir = this.packInstallDir(packId);
        if (!fs.existsSync(dir)) return null;
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

    _speakWithPiper(bin, model, text, volume, pack) {
        return new Promise((resolve, reject) => {
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
            proc.on('error', reject);
            proc.on('close', (code) => {
                if (code !== 0 || !fs.existsSync(wavPath)) {
                    return this._speakWithSapi(text, volume, 0, null).then(resolve, reject);
                }
                this._playWav(wavPath, volume).then(() => {
                    try { fs.unlinkSync(wavPath); } catch (e) {}
                    resolve();
                }, reject);
            });
        });
    }

    _playWav(wavPath, volume) {
        return new Promise((resolve, reject) => {
            const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]'${wavPath.replace(/'/g, "''")}')
$p.Volume = ${Math.max(0, Math.min(1, volume / 100))}
$p.Play()
Start-Sleep -Milliseconds 200
while ($p.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 50 }
$ms = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds
if ($ms -lt 100) { $ms = 100 }
Start-Sleep -Milliseconds ($ms + 120)
$p.Close()
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
            if (!/Closed streaming|dispatch complete \(queuedFinal=true, replies=[1-9]/i.test(t)) {
                return;
            }
            if (this._channelSpeakTimer) clearTimeout(this._channelSpeakTimer);
            this._channelSpeakTimer = setTimeout(() => {
                this._channelSpeakTimer = null;
                this._speakLatestAssistantFromSessions();
            }, 600);
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
