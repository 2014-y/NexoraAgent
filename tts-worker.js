'use strict';

/**
 * 离线 TTS 合成子进程（sherpa-onnx）
 * 用法:
 *   node tts-worker.js --model-dir <已解压语音包目录> --text-file <utf8 文本文件> --out <输出 wav> [--sid 0] [--speed 1.0]
 * 由 voice-runtime 通过 ELECTRON_RUN_AS_NODE 或系统 node 启动。
 * 成功时向 stdout 输出一行 JSON: {"ok":true,"wav":"...","sampleRate":22050}
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        if (key.startsWith('--')) {
            out[key.slice(2)] = argv[i + 1];
            i++;
        }
    }
    return out;
}

function fail(msg) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(msg) }) + '\n');
    process.exit(1);
}

/** 递归扫描语音包目录，识别 sherpa-onnx vits 所需资产 */
function scanModelAssets(rootDir) {
    const assets = {
        model: null,
        tokens: null,
        lexicon: null,
        dataDir: null,   // espeak-ng-data（piper 系）
        dictDir: null,   // jieba dict（中文 vits/melo 系）
        ruleFsts: [],
        ruleFars: []
    };
    const stack = [rootDir];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
        for (const ent of entries) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === 'espeak-ng-data') assets.dataDir = full;
                else if (ent.name === 'dict') assets.dictDir = full;
                else stack.push(full);
                continue;
            }
            const lower = ent.name.toLowerCase();
            if (lower.endsWith('.onnx')) {
                // 跳过 .onnx.json 之类的旁支；多 onnx 时取体积最大的（主模型）
                if (!assets.model || fs.statSync(full).size > fs.statSync(assets.model).size) {
                    assets.model = full;
                }
            } else if (lower === 'tokens.txt') assets.tokens = full;
            else if (lower === 'lexicon.txt') assets.lexicon = full;
            else if (lower.endsWith('.fst')) assets.ruleFsts.push(full);
            else if (lower.endsWith('.far')) assets.ruleFars.push(full);
        }
    }
    return assets;
}

function main() {
    const args = parseArgs(process.argv);
    const modelDir = args['model-dir'];
    const textFile = args['text-file'];
    const outWav = args['out'];
    const sid = Number(args['sid'] || 0) | 0;
    const speed = Number(args['speed'] || 1.0) || 1.0;

    if (!modelDir || !fs.existsSync(modelDir)) return fail('model dir not found: ' + modelDir);
    if (!textFile || !fs.existsSync(textFile)) return fail('text file not found: ' + textFile);
    if (!outWav) return fail('missing --out');

    const text = fs.readFileSync(textFile, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return fail('empty text');

    // Windows 下需把原生 DLL 目录加入 PATH 再加载扩展
    try {
        const nativeDir = path.dirname(require.resolve('sherpa-onnx-win-x64/package.json'));
        process.env.PATH = nativeDir + path.delimiter + (process.env.PATH || '');
    } catch (e) { /* 非 Windows 或包名不同时忽略 */ }

    let sherpa;
    try {
        sherpa = require('sherpa-onnx-node');
    } catch (e) {
        return fail('sherpa-onnx-node not available: ' + e.message);
    }

    const a = scanModelAssets(modelDir);
    if (!a.model) return fail('no .onnx model found in ' + modelDir);
    if (!a.tokens) return fail('no tokens.txt found in ' + modelDir);

    const vits = {
        model: a.model,
        tokens: a.tokens
    };
    if (a.lexicon) vits.lexicon = a.lexicon;
    if (a.dataDir) vits.dataDir = a.dataDir;
    if (a.dictDir) vits.dictDir = a.dictDir;

    const config = {
        model: {
            vits,
            debug: false,
            numThreads: 2,
            provider: 'cpu'
        },
        maxNumSentences: 1
    };
    if (a.ruleFsts.length) config.ruleFsts = a.ruleFsts.join(',');
    if (a.ruleFars.length) config.ruleFars = a.ruleFars.join(',');

    let tts;
    try {
        tts = new sherpa.OfflineTts(config);
    } catch (e) {
        return fail('OfflineTts init failed: ' + e.message);
    }

    let audio;
    try {
        const maxSid = Math.max(0, (tts.numSpeakers || 1) - 1);
        // Electron 的 V8 内存沙箱禁止 external buffer，必须显式关闭
        audio = tts.generate({ text, sid: Math.min(sid, maxSid), speed, enableExternalBuffer: false });
    } catch (e) {
        return fail('generate failed: ' + e.message);
    }
    if (!audio || !audio.samples || !audio.samples.length) return fail('empty audio');

    try {
        fs.mkdirSync(path.dirname(outWav), { recursive: true });
        sherpa.writeWave(outWav, { samples: audio.samples, sampleRate: audio.sampleRate });
    } catch (e) {
        return fail('writeWave failed: ' + e.message);
    }

    process.stdout.write(JSON.stringify({ ok: true, wav: outWav, sampleRate: audio.sampleRate }) + '\n');
    process.exit(0);
}

main();
