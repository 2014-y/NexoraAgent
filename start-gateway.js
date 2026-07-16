// start-gateway.js
// Nexora Agent - Node.js 启动入口
// 用法: node start-gateway.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  resolveStableOpenClawHome,
  applyOpenClawHomeEnv,
  detectRestrictedDesktop,
  probeOpenClawHomeWritable
} = require('./home-resolve');

const preferredHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
const desktopInfo = detectRestrictedDesktop(process.env);
const preferredWritable = preferredHome ? probeOpenClawHomeWritable(preferredHome) : false;
const resolved = (!preferredWritable || desktopInfo.restricted)
  ? resolveStableOpenClawHome(preferredWritable ? preferredHome : null, {
      installDir: __dirname,
      env: process.env,
      appPaths: { home: preferredHome }
    })
  : { homePath: preferredHome };

applyOpenClawHomeEnv(resolved.homePath, process.env);
const BASE_PATH = process.env.OPENCLAW_STATE_DIR || path.join(resolved.homePath, '.openclaw');
const CONFIG_PATH = path.join(BASE_PATH, 'openclaw.json');

const possibleSandboxNode = path.join(__dirname, '.node-sandbox', 'node.exe');
const nodeExePath = fs.existsSync(possibleSandboxNode) ? possibleSandboxNode : (process.argv[0] || 'node');

let localOpenClawPath = null;

function checkPrerequisites() {
  console.log('[检查] 前置依赖...\n');
  console.log(`[状态目录] ${BASE_PATH}`);
  
  // 检查 Node.js
  try {
    const version = execSync(`"${nodeExePath}" --version`, { encoding: 'utf8' }).trim();
    const sandboxLabel = fs.existsSync(possibleSandboxNode) ? ' (内置沙箱)' : '';
    console.log(`✓ Node.js ${version}${sandboxLabel}`);
  } catch (e) {
    console.error('✗ Node.js 未安装，请先安装 Node.js 20+');
    process.exit(1);
  }
  
  // 检查 openclaw
  const possibleLocalPath = path.join(__dirname, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (fs.existsSync(possibleLocalPath)) {
    localOpenClawPath = possibleLocalPath;
    console.log(`✓ OpenClaw: ${localOpenClawPath} (本地安装)`);
  } else {
    try {
      const cliPath = execSync('where openclaw', { encoding: 'utf8' }).trim();
      console.log(`✓ OpenClaw: ${cliPath} (全局安装)`);
    } catch (e) {
      console.error('✗ OpenClaw 未安装。请运行 npm install 安装依赖。');
      process.exit(1);
    }
  }
  
  // 检查配置
  fs.mkdirSync(BASE_PATH, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('\n⚠ 配置文件不存在，正在初始化...\n');
    const examplePath = path.join(__dirname, 'config', 'openclaw.json.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, CONFIG_PATH);
      console.log(`✓ 已从模板创建配置: ${CONFIG_PATH}`);
      console.log('  请编辑配置文件，填入你的 API Key\n');
    }
  }
  
  console.log('\n========================================');
  console.log('  Nexora Agent - 启动中...');
  console.log('========================================\n');
}

function startGateway() {
  try {
    let cmd;
    if (localOpenClawPath) {
      cmd = `"${nodeExePath}" "${localOpenClawPath}" gateway run --force`;
    } else {
      cmd = 'openclaw gateway run --force';
    }
    
    execSync(cmd, {
      cwd: BASE_PATH,
      stdio: 'inherit',
      shell: true,
      env: process.env
    });
  } catch (e) {
    console.error('Gateway 启动失败:', e.message);
    process.exit(1);
  }
}

checkPrerequisites();
startGateway();
