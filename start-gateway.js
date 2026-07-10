// start-gateway.js
// AI-v24.13.0 开源版 - Node.js 启动入口
// 用法: node start-gateway.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw');
const CONFIG_PATH = path.join(BASE_PATH, 'openclaw.json');

function checkPrerequisites() {
  console.log('[检查] 前置依赖...\n');
  
  // 检查 Node.js
  try {
    const version = execSync('node --version', { encoding: 'utf8' }).trim();
    console.log(`✓ Node.js ${version}`);
  } catch (e) {
    console.error('✗ Node.js 未安装，请先安装 Node.js 20+');
    process.exit(1);
  }
  
  // 检查 openclaw
  try {
    const cliPath = execSync('where openclaw', { encoding: 'utf8' }).trim();
    console.log(`✓ OpenClaw: ${cliPath}`);
  } catch (e) {
    console.error('✗ OpenClaw 未全局安装，运行: npm install -g openclaw@2026.6.11');
    process.exit(1);
  }
  
  // 检查配置
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
  console.log(' AI-v24.13.0 开源版 - 启动中...');
  console.log('========================================\n');
}

function startGateway() {
  try {
    const openclawCmd = 'openclaw';
    const args = ['gateway', 'run', '--force'];
    
    const child = execSync(openclawCmd + ' ' + args.join(' '), {
      cwd: BASE_PATH,
      stdio: 'inherit',
      shell: true
    });
  } catch (e) {
    console.error('Gateway 启动失败:', e.message);
    process.exit(1);
  }
}

checkPrerequisites();
startGateway();
