/**
 * 直接调用 @tencent-weixin/openclaw-weixin 扫码登录 API，
 * 绕开 `openclaw channels login`（会偶发 Channel does not support login）。
 *
 * 协议：stdout 逐行 JSON
 *   {"type":"qr","url":"..."}
 *   {"type":"log","message":"..."}
 *   {"type":"success","accountId":"...","userId":"..."}
 *   {"type":"error","message":"..."}
 *
 * env:
 *   WEIXIN_PLUGIN_ROOT  插件根目录（含 dist/src/auth/login-qr.js）
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function normalizeAccountId(id) {
  return String(id || '')
    .trim()
    .replace(/@/g, '-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'weixin';
}

async function main() {
  const pluginRoot = process.env.WEIXIN_PLUGIN_ROOT;
  if (!pluginRoot) {
    emit({ type: 'error', message: 'WEIXIN_PLUGIN_ROOT 未设置' });
    process.exit(1);
  }

  const loginQrUrl = pathToFileURL(path.join(pluginRoot, 'dist', 'src', 'auth', 'login-qr.js')).href;
  const accountsUrl = pathToFileURL(path.join(pluginRoot, 'dist', 'src', 'auth', 'accounts.js')).href;

  let loginQr;
  let accounts;
  try {
    loginQr = await import(loginQrUrl);
    accounts = await import(accountsUrl);
  } catch (e) {
    emit({ type: 'error', message: `加载微信登录模块失败: ${e.message || e}` });
    process.exit(1);
  }

  const botType = loginQr.DEFAULT_ILINK_BOT_TYPE || '3';
  emit({ type: 'log', message: '正在向微信请求登录二维码...' });

  let startResult;
  try {
    startResult = await loginQr.startWeixinLoginWithQr({
      botType,
      verbose: false,
    });
  } catch (e) {
    emit({ type: 'error', message: `拉取二维码失败: ${e.message || e}` });
    process.exit(1);
  }

  if (!startResult || !startResult.qrcodeUrl) {
    emit({ type: 'error', message: (startResult && startResult.message) || '未返回二维码链接' });
    process.exit(1);
  }

  emit({ type: 'qr', url: startResult.qrcodeUrl });
  emit({ type: 'log', message: '二维码已生成，请用手机微信扫码确认...' });

  let waitResult;
  try {
    waitResult = await loginQr.waitForWeixinLogin({
      sessionKey: startResult.sessionKey,
      apiBaseUrl: accounts.DEFAULT_BASE_URL || 'https://ilinkai.weixin.qq.com',
      timeoutMs: 480_000,
      verbose: false,
      botType,
    });
  } catch (e) {
    emit({ type: 'error', message: `等待扫码失败: ${e.message || e}` });
    process.exit(1);
  }

  if (waitResult && waitResult.alreadyConnected) {
    emit({ type: 'success', accountId: 'already-connected', alreadyConnected: true });
    process.exit(0);
  }

  if (waitResult && waitResult.connected && waitResult.botToken && waitResult.accountId) {
    try {
      const normalizedId = normalizeAccountId(waitResult.accountId);
      accounts.saveWeixinAccount(normalizedId, {
        token: waitResult.botToken,
        baseUrl: waitResult.baseUrl,
        userId: waitResult.userId,
      });
      accounts.registerWeixinAccountId(normalizedId);
      emit({
        type: 'success',
        accountId: normalizedId,
        userId: waitResult.userId || null,
      });
      process.exit(0);
    } catch (e) {
      emit({ type: 'error', message: `保存微信账号失败: ${e.message || e}` });
      process.exit(1);
    }
  }

  emit({ type: 'error', message: (waitResult && waitResult.message) || '扫码未完成' });
  process.exit(1);
}

main().catch((e) => {
  emit({ type: 'error', message: String(e && e.message || e) });
  process.exit(1);
});
