const fs = require('fs');
const path = require('path');

// 自动为打包初始化 .node-sandbox 目录（防空漏）
try {
    const sandboxDir = path.join(__dirname, '.node-sandbox');
    const sandboxNode = path.join(sandboxDir, 'node.exe');
    if (!fs.existsSync(sandboxNode)) {
        console.log('Detecting missing .node-sandbox/node.exe, automatically initializing...');
        if (!fs.existsSync(sandboxDir)) {
            fs.mkdirSync(sandboxDir, { recursive: true });
        }
        
        // 获取当前运行的 node 执行路径
        const currentExec = process.execPath;
        if (currentExec && currentExec.toLowerCase().endsWith('node.exe') && fs.existsSync(currentExec)) {
            const currentDir = path.dirname(currentExec);
            
            // 拷贝 node.exe
            fs.copyFileSync(currentExec, sandboxNode);
            console.log(`Copied node.exe from ${currentExec} to ${sandboxNode}`);
            
            // 尝试拷贝其它关联文件，例如 npm, npx 等（不要拷贝整棵全局 node_modules，会拖慢安装/卸载）
            const filesToCopy = ['npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'nodevars.bat'];
            filesToCopy.forEach(file => {
                const srcFile = path.join(currentDir, file);
                const destFile = path.join(sandboxDir, file);
                if (fs.existsSync(srcFile)) {
                    fs.copyFileSync(srcFile, destFile);
                    console.log(`Copied ${file} to sandbox`);
                }
            });
        } else {
            console.warn('Current execPath does not seem to be node.exe or cannot find it:', currentExec);
        }
    }
} catch (e) {
    console.error('Error setting up node-sandbox dynamically:', e);
}

function findNsh(dir) {
    let results = [];
    try {
        const list = fs.readdirSync(dir);
        list.forEach(file => {
            file = path.join(dir, file);
            const stat = fs.statSync(file);
            if (stat && stat.isDirectory() && !file.includes('.asar')) {
                results = results.concat(findNsh(file));
            } else {
                if (file.endsWith('installSection.nsh')) {
                    results.push(file);
                }
            }
        });
    } catch (e) {}
    return results;
}

try {
    console.log('NSIS detail patches skipped (keep SetDetailsPrint none for faster install UI).');
} catch (e) {
    console.error('Error patching NSIS:', e);
}
