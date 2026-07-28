'use strict';
/**
 * Google OAuth 2.0 登录与 Google Drive AppData 云同步模块（Electron 桌面端）。
 * - 支持 OAuth 登录（通过系统默认浏览器）
 * - 支持将应用配置无缝备份/恢复到用户的 Google Drive 隐藏 AppData 目录
 */
const { shell } = require('electron');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

const fs = require('fs');
const path = require('path');

function getGoogleCredentials() {
    const searchDirs = [
        __dirname,
        process.resourcesPath,
        process.cwd()
    ].filter(Boolean);

    for (const dir of searchDirs) {
        try {
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir).filter((f) => f.startsWith('client_secret_') && f.endsWith('.json'));
            if (files.length > 0) {
                const json = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
                const creds = json.installed || json.web || {};
                if (creds.client_id && creds.client_secret) {
                    return { clientId: creds.client_id, clientSecret: creds.client_secret };
                }
            }
        } catch (_) {}
    }

    return {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || ''
    };
}

const REDIRECT_PATH = '/oauth2callback';
const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
const DRIVE_CONFIG_FILENAME = 'nexora-agent-config.json';

let _loginInProgress = false;

function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function findAvailablePort() {
    return new Promise((resolve, reject) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

/**
 * 启动 Google OAuth 登录流程（拉起系统默认浏览器）。
 * @returns {Promise<{success: boolean, user?: object, tokens?: object, error?: string}>}
 */
async function startGoogleLogin() {
    if (_loginInProgress) {
        return { success: false, error: 'Google 登录已在进行中' };
    }
    _loginInProgress = true;

    let server = null;

    try {
        const port = await findAvailablePort();
        const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`;
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = crypto.randomBytes(16).toString('hex');

        const creds = getGoogleCredentials();
        if (!creds.clientId) {
            _loginInProgress = false;
            return { success: false, error: '未找到有效的 Google OAuth 凭据文件 (client_secret_*.json) 或环境变量' };
        }
        const authParams = new URLSearchParams({
            client_id: creds.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: SCOPES,
            state: state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            access_type: 'offline',
            prompt: 'consent',
        });
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

        const result = await new Promise((resolve, reject) => {
            // 设置 45 秒超时兜底，避免用户关闭或拦截网页后长时间等待
            const timeoutTimer = setTimeout(() => {
                resolve({ success: false, error: '授权超时或网页已关闭，请重试' });
            }, 45000);

            server = http.createServer(async (req, res) => {
                const parsed = url.parse(req.url, true);
                if (parsed.pathname !== REDIRECT_PATH) {
                    res.writeHead(404);
                    res.end();
                    return;
                }

                clearTimeout(timeoutTimer);

                const { code, state: returnedState, error } = parsed.query;

                if (error) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;background:#1a1a2e;color:#e0e0e0;"><div style="text-align:center;"><h2 style="color:#ef4444;">授权失败</h2><p>您可以关闭此标签页。</p></div></body></html>');
                    resolve({ success: false, error: `Google 授权失败: ${error}` });
                    return;
                }

                if (returnedState !== state) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;background:#1a1a2e;color:#e0e0e0;"><div style="text-align:center;"><h2 style="color:#ef4444;">安全校验失败</h2><p>state 不匹配，请重试。</p></div></body></html>');
                    resolve({ success: false, error: 'state 校验失败' });
                    return;
                }

                try {
                    const tokenData = await exchangeCodeForToken(code, redirectUri, codeVerifier);
                    const userInfo = await fetchGoogleUserInfo(tokenData.access_token);

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;background:#1a1a2e;color:#e0e0e0;">
                        <div style="text-align:center;">
                            <div style="font-size:48px;margin-bottom:16px;">✅</div>
                            <h2 style="margin:0 0 8px 0;">Google 登录成功</h2>
                            <p style="color:#aaa;">欢迎，${userInfo.name || userInfo.email}！您可以关闭此标签页并返回 Nexora Agent 应用。</p>
                            <script>setTimeout(() => window.close(), 3000);</script>
                        </div>
                    </body></html>`);

                    resolve({
                        success: true,
                        user: {
                            id: userInfo.sub,
                            email: userInfo.email,
                            name: userInfo.name || '',
                            picture: userInfo.picture || '',
                            locale: userInfo.locale || '',
                        },
                        tokens: {
                            access_token: tokenData.access_token,
                            refresh_token: tokenData.refresh_token || null,
                            expires_in: tokenData.expires_in,
                        },
                    });
                } catch (e) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;background:#1a1a2e;color:#e0e0e0;"><div style="text-align:center;"><h2 style="color:#ef4444;">登录处理失败</h2><p>请返回应用重试。</p></div></body></html>');
                    resolve({ success: false, error: e.message });
                }
            });

            server.listen(port, '127.0.0.1', () => {
                shell.openExternal(authUrl).catch((err) => {
                    clearTimeout(timeoutTimer);
                    reject(new Error(`打开浏览器失败: ${err.message}`));
                });
            });

            server.on('error', (e) => {
                clearTimeout(timeoutTimer);
                reject(new Error(`本地回调服务器启动失败: ${e.message}`));
            });
        });

        return result;
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    } finally {
        _loginInProgress = false;
        if (server) {
            try { server.close(); } catch (_) {}
        }
    }
}

async function exchangeCodeForToken(code, redirectUri, codeVerifier) {
    const creds = getGoogleCredentials();
    const body = new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Token 交换失败 (HTTP ${res.status}): ${text}`);
    }
    return await res.json();
}

async function refreshAccessToken(refreshToken) {
    const creds = getGoogleCredentials();
    const body = new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`刷新 Token 失败: ${text}`);
    }
    return await res.json();
}

async function fetchGoogleUserInfo(accessToken) {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
        throw new Error(`获取用户信息失败 (HTTP ${res.status})`);
    }
    return await res.json();
}

/**
 * 查找 AppData 文件夹中是否存在配置备份文件
 */
async function findDriveConfigFile(accessToken) {
    const query = encodeURIComponent(`name='${DRIVE_CONFIG_FILENAME}' and 'appDataFolder' in parents and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        throw new Error(`查询 Google Drive 失败 (HTTP ${res.status})`);
    }
    const data = await res.json();
    return (data.files && data.files.length > 0) ? data.files[0] : null;
}

/**
 * 将配置内容写入/保存到用户的 Google Drive AppData
 */
async function uploadConfigToDrive(accessToken, configContentString) {
    const existingFile = await findDriveConfigFile(accessToken);

    if (existingFile) {
        // PATCH 现有文件
        const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=media`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: configContentString,
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`更新 Google Drive 文件失败: ${errText}`);
        }
        return await res.json();
    } else {
        // 创建新文件（Multipart 上传）
        const boundary = '-------314159265358979323846';
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";

        const metadata = {
            name: DRIVE_CONFIG_FILENAME,
            parents: ['appDataFolder'],
            mimeType: 'application/json',
        };

        const multipartRequestBody =
            delimiter +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            JSON.stringify(metadata) +
            delimiter +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            configContentString +
            close_delim;

        const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary="${boundary}"`,
            },
            body: multipartRequestBody,
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`创建 Google Drive 文件失败: ${errText}`);
        }
        return await res.json();
    }
}

/**
 * 从用户的 Google Drive AppData 下载最新配置
 */
async function downloadConfigFromDrive(accessToken) {
    const existingFile = await findDriveConfigFile(accessToken);
    if (!existingFile) {
        return null; // 云端暂无备份
    }

    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${existingFile.id}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
        throw new Error(`从 Google Drive 读取备份失败 (HTTP ${res.status})`);
    }

    const text = await res.text();
    return {
        fileId: existingFile.id,
        content: text,
    };
}

function cancelGoogleLogin() {
    _loginInProgress = false;
}

module.exports = {
    startGoogleLogin,
    cancelGoogleLogin,
    refreshAccessToken,
    uploadConfigToDrive,
    downloadConfigFromDrive,
};
