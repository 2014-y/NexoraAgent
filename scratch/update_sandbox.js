const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const scriptDir = path.resolve(__dirname, '..');
const sandboxDir = path.join(scriptDir, ".node-sandbox");
const tempZip = path.join(scriptDir, "node-v24.15.0.zip");
const tempExtract = path.join(scriptDir, "node-v24.15.0-temp");

async function main() {
    console.log("正在停止所有沙箱 Node 进程...");
    try {
        execSync('powershell -ExecutionPolicy Bypass -NoProfile -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like \'*\\.node-sandbox\\node.exe\' } | Stop-Process -Force"');
    } catch (e) {
        // 忽略找不到进程的报错
    }

    console.log("正在下载 Node.js v24.15.0 绿色版 (从国内镜像)...");
    const downloadUrl = "https://npmmirror.com/mirrors/node/v24.15.0/node-v24.15.0-win-x64.zip";
    try {
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error("Status " + response.status);
        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(tempZip, Buffer.from(arrayBuffer));
        console.log("下载成功！");
    } catch (err) {
        console.log("从国内镜像下载失败，正在尝试官方镜像...", err.message);
        const fallbackUrl = "https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip";
        try {
            const response = await fetch(fallbackUrl);
            if (!response.ok) throw new Error("Status " + response.status);
            const arrayBuffer = await response.arrayBuffer();
            fs.writeFileSync(tempZip, Buffer.from(arrayBuffer));
            console.log("下载成功！");
        } catch (fallbackErr) {
            console.error("下载失败！请检查您的网络连接。", fallbackErr.message);
            process.exit(1);
        }
    }

    console.log("正在解压文件...");
    if (fs.existsSync(tempExtract)) {
        fs.rmSync(tempExtract, { recursive: true, force: true });
    }
    try {
        execSync(`powershell -ExecutionPolicy Bypass -NoProfile -Command "Expand-Archive -Path '${tempZip}' -DestinationPath '${tempExtract}' -Force"`);
    } catch (e) {
        console.error("解压失败！", e.message);
        process.exit(1);
    }

    const extractedDir = path.join(tempExtract, "node-v24.15.0-win-x64");

    console.log("正在替换沙箱中的文件...");
    try {
        if (!fs.existsSync(sandboxDir)) {
            fs.mkdirSync(sandboxDir, { recursive: true });
        }

        // 复制核心 node.exe
        fs.copyFileSync(path.join(extractedDir, "node.exe"), path.join(sandboxDir, "node.exe"));
        
        // 复制核心命令文件
        const filesToCopy = ["npm", "npm.cmd", "npx", "npx.cmd", "corepack", "corepack.cmd"];
        for (const file of filesToCopy) {
            const srcFile = path.join(extractedDir, file);
            if (fs.existsSync(srcFile)) {
                fs.copyFileSync(srcFile, path.join(sandboxDir, file));
            }
        }

        // 替换 node_modules 目录
        const destModules = path.join(sandboxDir, "node_modules");
        if (fs.existsSync(destModules)) {
            fs.rmSync(destModules, { recursive: true, force: true });
        }
        
        // 在 Windows 上复制整个目录，我们用 robocopy
        try {
            execSync(`robocopy "${path.join(extractedDir, "node_modules")}" "${destModules}" /E /NJH /NJS /ndl /nc /ns`);
        } catch (copyErr) {
            // robocopy 的 exit code <= 7 均表示成功，但 node child_process 默认只把 0 看成成功。所以我们需要捕获它以防异常退出。
        }
    } catch (e) {
        console.error("文件替换出错：", e.message);
        process.exit(1);
    }

    console.log("正在清理临时下载文件...");
    try {
        if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
        if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true });
    } catch (e) {}

    console.log("========================================");
    console.log("沙箱 Node.js 成功联动升级至真正的 v24.15.0！");
    console.log("========================================");
}

main();
