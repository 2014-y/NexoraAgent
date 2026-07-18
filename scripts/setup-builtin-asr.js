const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2';
const destDir = path.join(__dirname, '../builtin-asr');
const archive = path.join(__dirname, '../builtin-asr.tar.bz2');

function download(url, dest, callback) {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
            return download(res.headers.location, dest, callback);
        }
        res.pipe(file);
        file.on('finish', () => {
            file.close(callback);
        });
    }).on('error', (err) => {
        fs.unlink(dest, () => {});
        console.error('Download failed:', err);
    });
}

console.log('Downloading ASR model to:', archive);
if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}
download(url, archive, () => {
    console.log('Download complete. Extracting to:', destDir);
    execFile('tar', ['-xjf', archive, '-C', destDir], { windowsHide: true }, (err, stdout, stderr) => {
        try { fs.unlinkSync(archive); } catch (e) {}
        if (err) {
            console.error('Extraction failed:', stderr || err.message);
        } else {
            console.log('Extraction complete! ASR model is now built-in.');
        }
    });
});
