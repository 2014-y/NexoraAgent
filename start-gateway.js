// start-gateway.js
// Nexora Agent - Node.js 启动入口
// 用法: node start-gateway.js

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  resolveStableOpenClawHome,
  applyOpenClawHomeEnv,
  detectRestrictedDesktop,
  probeOpenClawHomeWritable
} = require('./home-resolve');
const { ensureLatencySafeConfig } = require('./latency-tune');
const { hardenGatewayBootAgainstPluginNpm } = require('./gateway-boot-harden');

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
      const whichCmd = process.platform === 'win32' ? 'where openclaw' : 'command -v openclaw';
      const cliPath = execSync(whichCmd, { encoding: 'utf8' }).trim();
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

  // 与 Electron 启动路径对齐：修配置 + soft-skip Doctor + 种 npm
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
      const tuned = ensureLatencySafeConfig(raw);
      const hard = hardenGatewayBootAgainstPluginNpm({
        runtimeRoot: __dirname,
        projectRoot: __dirname,
        config: tuned.config,
        templateSources: [
          path.join(__dirname, 'config', 'openclaw-templates'),
          path.join(__dirname, 'node_modules', 'openclaw', 'docs', 'reference', 'templates'),
          path.join(__dirname, 'node_modules', 'openclaw', 'src', 'agents', 'templates')
        ]
      });
      if (tuned.changed || (hard && hard.configChanged)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(tuned.config, null, 2), 'utf8');
        console.log('✓ 已应用 latency/插件启动硬化');
      }
      if (hard && hard.notes) console.log('✓ gateway harden:', hard.notes.join(', '));
    }
  } catch (e) {
    console.warn('⚠ 启动硬化跳过:', e.message);
  }
  
  console.log('\n========================================');
  console.log('  Nexora Agent - 启动中...');
  console.log('========================================\n');
}

function startGateway() {
  // 用参数数组启动, 避免安装路径里的 & / ^ 等字符破坏 shell 命令行
  let exePath;
  let args;
  if (localOpenClawPath) {
    exePath = nodeExePath;
    args = [localOpenClawPath, 'gateway', 'run', '--force'];
  } else {
    exePath = 'openclaw';
    args = ['gateway', 'run', '--force'];
  }

  // 本地路径直接跑 node(无 shell, 路径安全); 全局 openclaw 在 Windows 是 .cmd, 需 shell 解析 PATH
  // (此分支不含用户安装路径, 无特殊字符注入风险)
  const useShell = !localOpenClawPath;
  const result = spawnSync(exePath, args, {
    cwd: BASE_PATH,
    stdio: 'inherit',
    shell: useShell,
    env: process.env
  });

  if (result.error) {
    console.error('Gateway 启动失败:', result.error.message);
    process.exit(1);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

checkPrerequisites();
startGateway();
