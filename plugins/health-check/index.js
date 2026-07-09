/**
 * health-check 插件 — OpenClaw 启动自检
 *
 * 功能：
 * 1. Gateway 启动时自动运行，探测 desktop-control.ps1 所有命令的实际可用性
 * 2. 生成 capabilities.json 能力清单文件
 * 3. AI 每次操作前读取该清单，只使用确认可用的能力
 *
 * 使用方式：
 * - 放在 ~/.openclaw/plugins/health-check/index.js
 * - 在 openclaw.json 的 plugins.allow 中添加 "health-check"
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── 常量 ───
const PROFILE = process.env.USERPROFILE || require('os').homedir();
const SCRIPT_PATH = path.join(PROFILE, '.openclaw', 'desktop-control.ps1');
const CACHE_DIR = path.join(PROFILE, '.openclaw', 'workspace', '.desktop-cache');
const CAPABILITIES_PATH = path.join(CACHE_DIR, 'capabilities.json');
const HEALTH_LOG_PATH = path.join(PROFILE, '.openclaw', 'logs', 'health-check.jsonl');

// ─── 能力探测定义 ───
const CAPABILITY_TESTS = [
  // --- 屏幕相关 ---
  { id: 'screen-info', desc: '显示器信息', cmd: ['screen-info'], pass: (o) => o.includes('Monitors') },
  { id: 'screen-capture-full', desc: '全屏截图', cmd: ['screen-capture'], pass: (o) => o.includes('.png') },
  { id: 'screen-capture-window', desc: '窗口截图', cmd: ['screen-capture', '--target', 'cmd'], pass: (o) => o.includes('.png') },

  // --- 应用管理 ---
  { id: 'app-list', desc: '列出窗口', cmd: ['app-list'], pass: (o) => o.includes('PID=') || o.includes('Monitor=') },
  { id: 'app-start', desc: '启动应用', cmd: ['app-start', 'notepad'], pass: (o) => o.toLowerCase().includes('started') },
  { id: 'app-focus', desc: '聚焦窗口', cmd: ['app-focus', 'cmd'], pass: (o) => o.includes('Focused:') || o.includes('PID=') },
  { id: 'app-close', desc: '关闭应用', cmd: ['app-close', 'notepad'], pass: (o) => o.includes('Closed:') || o.includes('Killed:') || o.includes('NOT_FOUND') },
  { id: 'app-close-notepad', desc: '关闭记事本', cmd: ['app-close', 'notepad'], pass: (o) => o.includes('Closed:') || o.includes('Killed:') || o.includes('NOT_FOUND') },

  // --- 窗口操作 ---
  { id: 'win-fullscreen', desc: '最大化窗口', cmd: ['win-fullscreen', 'cmd'], pass: (o) => o.includes('Maximized:') || o.includes('NOT_FOUND') },
  { id: 'win-minimize', desc: '最小化窗口', cmd: ['win-minimize', 'cmd'], pass: (o) => o.includes('Minimized:') || o.includes('NOT_FOUND') },

  // --- 鼠标控制 ---
  { id: 'mouse-click', desc: '鼠标点击', cmd: ['mouse-click', 'cmd', '--pct', '0.5', '0.5'], pass: (o) => o.includes('Clicking at') || o.includes('NOT_FOUND') },
  { id: 'mouse-scroll', desc: '鼠标滚动', cmd: ['mouse-scroll', 'cmd', '--pct', '0.5', '0.5', '--delta', '120'], pass: (o) => o.includes('Scrolled at') || o.includes('NOT_FOUND') },

  // --- 键盘控制 ---
  { id: 'keyboard-send', desc: '键盘输入', cmd: ['keyboard-send', 'cmd', 'echo test'], pass: (o) => o.includes('Sent keys') || o.includes('NOT_FOUND') },
  { id: 'keyboard-shortcut', desc: '快捷键', cmd: ['keyboard-shortcut', 'cmd', 'Ctrl+A'], pass: (o) => o.includes('Shortcut') || o.includes('NOT_FOUND') },

  // --- 音量控制 ---
  { id: 'volume-set', desc: '设置音量', cmd: ['volume-set', '50'], pass: (o) => o.includes('Volume') && !o.toLowerCase().includes('error') },
  { id: 'volume-get', desc: '查询音量', cmd: ['volume-get'], pass: (o) => o.includes('Volume:') && !o.toLowerCase().includes('error') },
  { id: 'volume-toggle', desc: '静音切换', cmd: ['volume-toggle'], pass: (o) => o.includes('Toggled') && !o.toLowerCase().includes('error') },

  // --- 控件缓存 ---
  { id: 'cache-list', desc: '列出缓存', cmd: ['cache-list'], pass: () => true },
  { id: 'cache-save', desc: '保存缓存', cmd: ['cache-save', '_health_test', '--json-file', '/dev/stdin'], pass: (o) => o.includes('Cache saved:') || o.toLowerCase().includes('saved'), special: true },
];

// ─── 辅助函数 ───

/** 执行 PowerShell 命令，正确处理 exit code */
async function runPsCommand(args) {
  if (!args || args.length === 0) return { success: false, output: 'N/A', error: 'No command' };

  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      ...args
    ], { timeout: 20000, maxBuffer: 1024 * 1024 });

    // execFile 在 Windows 上返回 { stdout, stderr, code, signal }
    // 注意：不是 exitCode，是 code
    const code = result.code ?? result.status ?? 0;
    const output = (result.stdout || '').trim();
    const error = (result.stderr || '').trim();

    if (code !== 0) {
      return { success: false, output, error: error || `exit code ${code}` };
    }

    return { success: true, output, error: '' };
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
}

/** 探测 WMI 亮度能力 */
async function checkBrightnessCapability() {
  const result = { get: {}, set: {} };

  try {
    // 1. 检查 WmiMonitorBrightness 类是否存在且可读
    const getCmd = `try { $b = Get-CimInstance -Namespace 'root\\wmi' -ClassName 'WmiMonitorBrightness' -ErrorAction Stop; Write-Output "OK:CurrentBrightness=$($b.CurrentBrightness),Levels=$($b.Levels)" } catch { Write-Output "FAIL:$($_.Exception.Message)" }`;
    const getProc = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', getCmd], { timeout: 10000 });
    const getOut = (getProc.stdout || '').trim();
    const getCode = getProc.code ?? getProc.status ?? 0;

    if (getCode === 0 && getOut.startsWith('OK:')) {
      result.get.success = true;
      result.get.passed = true;
      result.get.value = getOut.substring(3);
    } else {
      result.get.success = false;
      result.get.error = getOut || `exit ${getCode}`;
    }

    // 2. 检查 WmiMonitorBrightnessMethods 类是否可写
    // 注意：实际设置亮度会改变屏幕，我们用 -WhatIf 或先读再恢复的方式来探测
    // 这里我们检查类和方法是否存在
    const setCmd = `try { $m = [WmiClass]'root\\wmi:WmiMonitorBrightnessMethods'; $methods = $m.Methods | Select-Object -ExpandProperty Name; Write-Output "METHODS:$($methods -join ',')" } catch { Write-Output "FAIL:$($_.Exception.Message)" }`;
    const setProc = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', setCmd], { timeout: 10000 });
    const setOut = (setProc.stdout || '').trim();
    const setCode = setProc.code ?? setProc.status ?? 0;

    if (setCode === 0 && setOut.startsWith('METHODS:')) {
      result.set.success = true;
      result.set.methods = setOut.substring(8);
      result.set.passed = true;
      result.set.note = 'WMI brightness methods available';
    } else {
      result.set.success = false;
      result.set.error = setOut || `exit ${setCode}`;
    }

  } catch (err) {
    result.get.error = err.message;
    result.set.error = err.message;
  }

  return result;
}

/** 探测系统基本信息 */
function checkSystemInfo() {
  return {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    memory: {
      total: Math.round(require('os').totalmem() / 1024 / 1024 / 1024 * 100) / 100,
      free: Math.round(require('os').freemem() / 1024 / 1024 / 1024 * 100) / 100,
    },
    cpus: require('os').cpus().length,
    uptime: Math.round(require('os').uptime()),
    user: process.env.USERNAME || 'unknown',
    userProfile: PROFILE,
  };
}

// ─── 核心：运行全部探测 ---
async function runHealthCheck() {
  console.log('[health-check] 开始系统自检...');

  const results = {
    timestamp: new Date().toISOString(),
    system: checkSystemInfo(),
    tests: {},
    summary: { total: 0, passed: 0, failed: 0 },
  };

  // 跑完所有 desktop-control.ps1 命令
  for (const test of CAPABILITY_TESTS) {
    results.summary.total++;
    console.log(`[health-check]   测试: ${test.desc}...`);

    let psResult;
    if (test.special) {
      // cache-save 特殊处理：需要传 JSON 到 stdin
      try {
        const tmpFile = path.join(PROFILE, 'AppData', 'Local', 'Temp', '_health_cache_test.json');
        fs.writeFileSync(tmpFile, JSON.stringify({ appName: '_health_test', version: 1, controls: {} }), 'utf-8');
        psResult = await runPsCommand(['cache-save', '_health_test', '--json-file', tmpFile]);
        try { fs.unlinkSync(tmpFile); } catch {}
      } catch (e) {
        psResult = { success: false, output: '', error: e.message };
      }
    } else {
      psResult = await runPsCommand(test.cmd);
    }

    let passed = false;
    let note = '';

    if (psResult.success) {
      passed = !!test.pass(psResult.output);
      note = passed ? 'OK' : psResult.output.substring(0, 100);
    } else {
      note = psResult.error || psResult.output;
      // 某些测试允许 NOT_FOUND（找不到应用是正常的）
      if (note.includes('NOT_FOUND')) {
        passed = true;
        note = 'OK (app not running, expected)';
      }
    }

    results.tests[test.id] = {
      description: test.desc,
      command: test.cmd.join(' '),
      success: psResult.success,
      passed,
      output: psResult.output.substring(0, 500),
      error: psResult.error || '',
      note,
    };

    if (passed) results.summary.passed++;
    else results.summary.failed++;
  }

  // 特殊处理亮度探测
  console.log('[health-check]   测试: 亮度控制（WMI）...');
  const bright = await checkBrightnessCapability();

  results.tests['brightness-get'] = {
    description: '读取屏幕亮度',
    command: 'WMI (special)',
    success: bright.get.success,
    passed: bright.get.passed || false,
    output: bright.get.value || '',
    error: bright.get.error || '',
    note: bright.get.passed ? `当前亮度: ${bright.get.value}` : (bright.get.error || 'WMI not available'),
  };

  results.tests['brightness-set'] = {
    description: '设置屏幕亮度',
    command: 'WMI (special)',
    success: bright.set.success,
    passed: bright.set.passed || false,
    output: bright.set.methods || '',
    error: bright.set.error || '',
    note: bright.set.passed ? `可用方法: ${bright.set.methods}` : (bright.set.error || 'WMI not available'),
  };

  results.summary.total += 2;
  if (results.tests['brightness-get'].passed) results.summary.passed++;
  else results.summary.failed++;
  if (results.tests['brightness-set'].passed) results.summary.passed++;
  else results.summary.failed++;

  // 生成可用/不可用命令列表
  results.availableCommands = Object.entries(results.tests)
    .filter(([, t]) => t.passed)
    .map(([id, t]) => `${id}: ${t.note}`);

  results.unavailableCommands = Object.entries(results.tests)
    .filter(([, t]) => !t.passed)
    .map(([id, t]) => `${id}: ${t.error || t.note}`);

  return results;
}

// ─── 保存结果 ---
function saveResults(results) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  fs.writeFileSync(CAPABILITIES_PATH, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`[health-check] 能力清单已保存: ${CAPABILITIES_PATH}`);

  // 追加健康日志
  const logDir = path.dirname(HEALTH_LOG_PATH);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(HEALTH_LOG_PATH, JSON.stringify({
    ts: results.timestamp,
    passed: results.summary.passed,
    failed: results.summary.failed,
    total: results.summary.total,
  }) + '\n', 'utf-8');
}

// ─── 生成 AI 可读的能力摘要 ---
function generateAiSummary(results) {
  const lines = [];
  lines.push(`# 系统自检报告 - ${results.timestamp}`);
  lines.push('');
  lines.push(`## 总览: ${results.summary.passed}/${results.summary.total} 项可用`);
  lines.push('');

  if (results.availableCommands.length > 0) {
    lines.push('### 可用的能力');
    for (const cmd of results.availableCommands) {
      lines.push(`- ${cmd}`);
    }
    lines.push('');
  }

  if (results.unavailableCommands.length > 0) {
    lines.push('### 不可用的能力');
    for (const cmd of results.unavailableCommands) {
      lines.push(`- ${cmd}`);
    }
    lines.push('');
  }

  // 亮度特别提示
  if (results.tests['brightness-get']?.passed) {
    lines.push(`### 亮度控制`);
    lines.push(`- 当前亮度: ${results.tests['brightness-get'].output}`);
    lines.push('- 可通过 WMI 设置亮度');
    lines.push('');
  }

  return lines.join('\n');
}

// ─── 插件入口 ---
export default function createPlugin(runtime) {
  const pluginName = 'health-check';

  console.log(`[${pluginName}] 启动自检插件正在初始化...`);

  let hasRun = false;

  async function runStartupCheck() {
    if (hasRun) return;
    hasRun = true;

    try {
      const results = await runHealthCheck();
      saveResults(results);

      const summary = generateAiSummary(results);
      console.log(`[health-check] 自检完成: ${results.summary.passed}/${results.summary.total} 通过`);
      console.log(`[health-check] 能力清单: ${CAPABILITIES_PATH}`);

      if (results.tests['brightness-get']?.passed) {
        console.log(`[health-check] 亮度控制已确认可用，当前亮度: ${results.tests['brightness-get'].output}`);
      }

      // 保存 AI 可读摘要
      const aiSummaryPath = path.join(CACHE_DIR, 'capabilities-summary.md');
      fs.writeFileSync(aiSummaryPath, summary, 'utf-8');
      console.log(`[health-check] AI 摘要已保存: ${aiSummaryPath}`);

    } catch (err) {
      console.error(`[health-check] 自检失败: ${err.message}`);
      try {
        const fallback = {
          timestamp: new Date().toISOString(),
          system: checkSystemInfo(),
          tests: {},
          summary: { total: 0, passed: 0, failed: 0 },
          availableCommands: [],
          unavailableCommands: [`startup-error: ${err.message}`],
        };
        saveResults(fallback);
      } catch {}
    }
  }

  return {
    name: pluginName,

    async onMessage(context) {
      if (!hasRun) {
        runStartupCheck();
      }
    },

    async manualCheck() {
      hasRun = false;
      return runStartupCheck();
    },
  };
}
