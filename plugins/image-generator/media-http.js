/**
 * Proxy-aware HTTP(S) for Agnes media APIs.
 * Node https.request ignores HTTP_PROXY; Clash fake-ip (198.18.x) needs CONNECT via local proxy.
 */

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import { URL } from "node:url";
import { execFileSync } from "node:child_process";

const PROXY_CANDIDATE_PORTS = [7890, 7897, 7891, 10809, 10808, 17890];

let cachedAutoProxy = undefined;
let cachedAgnesProxy = undefined;

const AGNES_API_HOST_RE = /(?:^|\.)agnes-ai\.com$/i;

function getProxyUrlFromEnv() {
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  return fromEnv && String(fromEnv).trim() ? String(fromEnv).trim() : null;
}

function findLocalMixedProxyUrl() {
  for (const port of PROXY_CANDIDATE_PORTS) {
    if (!isLocalPortListening(port)) continue;
    return `http://127.0.0.1:${port}`;
  }
  return null;
}

export function getProxyUrl() {
  const fromEnv = getProxyUrlFromEnv();
  if (fromEnv) return fromEnv;
  if (cachedAutoProxy !== undefined) return cachedAutoProxy;

  const fakeIp = detectFakeIpSample();
  cachedAutoProxy = fakeIp ? findLocalMixedProxyUrl() : null;
  return cachedAutoProxy;
}

function getProxyUrlForHost(hostname) {
  const fromEnv = getProxyUrlFromEnv();
  if (fromEnv) return fromEnv;
  const host = String(hostname || "").toLowerCase();
  if (AGNES_API_HOST_RE.test(host) || host === "apihub.agnes-ai.com") {
    if (cachedAgnesProxy !== undefined) return cachedAgnesProxy;
    cachedAgnesProxy = findLocalMixedProxyUrl();
    return cachedAgnesProxy;
  }
  return getProxyUrl();
}

function detectFakeIpSample() {
  try {
    if (process.env.NEXORA_FAKEIP_SAMPLE && /^198\.18\./.test(process.env.NEXORA_FAKEIP_SAMPLE)) {
      return process.env.NEXORA_FAKEIP_SAMPLE;
    }
    const out = execFileSync(
      "powershell",
      [
        "-ExecutionPolicy",
        "Bypass",
        "-NoProfile",
        "-Command",
        "try { (Resolve-DnsName apihub.agnes-ai.com -Type A -ErrorAction Stop | Select-Object -First 1 -ExpandProperty IPAddress) } catch { '' }",
      ],
      { encoding: "utf8", timeout: 4000, windowsHide: true }
    );
    const ip = String(out || "").trim();
    return /^198\.18\./.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

function isLocalPortListening(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return false;
  try {
    const out = execFileSync("cmd.exe", ["/c", `netstat -ano | findstr :${p}`], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return /(LISTENING|LISTEN)/i.test(String(out || "")) && new RegExp(`:${p}\\s`).test(String(out || ""));
  } catch {
    return false;
  }
}

function shouldBypassProxy(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h || h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || "localhost,127.0.0.1,::1");
  for (const entry of noProxy.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (entry === "*") return true;
    if (h === entry || h.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function readResponseBinary(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

function readResponse(res) {
  return readResponseBinary(res).then((buf) => buf.toString("utf8"));
}

function withDeadline(promise, timeoutMs, cleanup) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { cleanup?.(); } catch {}
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then((val) => finish(null, val), (err) => finish(err));
  });
}

function directRequest(urlObj, { method, headers, body, timeout, isHttps, signalDone, signalErr, registerCleanup }) {
  const transport = isHttps ? https : http;
  const req = transport.request(
    {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
      timeout,
    },
    signalDone
  );
  registerCleanup?.(() => {
    try { req.destroy(); } catch {}
  });
  req.on("error", signalErr);
  req.on("timeout", () => {
    req.destroy();
    signalErr(new Error("Request timeout"));
  });
  if (body != null) req.write(body);
  req.end();
  return req;
}

function proxyRequest(proxyUrl, urlObj, { method, headers, body, timeout, isHttps, signalDone, signalErr, registerCleanup }) {
  const proxy = new URL(proxyUrl);
  const targetHost = urlObj.hostname;
  const targetPort = urlObj.port || (isHttps ? 443 : 80);
  const targetPath = urlObj.pathname + urlObj.search;
  let connectReq = null;
  let tlsSocket = null;
  let connectSocket = null;
  let responseStarted = false;

  const cleanup = () => {
    try { tlsSocket?.destroy(); } catch {}
    try { connectSocket?.destroy(); } catch {}
    try { connectReq?.destroy(); } catch {}
  };
  registerCleanup?.(cleanup);

  if (!isHttps) {
    const req = http.request(
      {
        hostname: proxy.hostname,
        port: proxy.port || 80,
        path: urlObj.href,
        method,
        headers: {
          ...headers,
          Host: urlObj.host,
        },
        timeout,
      },
      signalDone
    );
    registerCleanup?.(() => {
      try { req.destroy(); } catch {}
    });
    req.on("error", signalErr);
    req.on("timeout", () => {
      req.destroy();
      signalErr(new Error("Proxy request timeout"));
    });
    if (body != null) req.write(body);
    req.end();
    return req;
  }

  connectReq = http.request({
    hostname: proxy.hostname,
    port: proxy.port || 80,
    method: "CONNECT",
    path: `${targetHost}:${targetPort}`,
    timeout,
  });

  connectReq.on("connect", (res, socket) => {
    connectSocket = socket;
    if (res.statusCode !== 200) {
      socket.destroy();
      signalErr(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
      return;
    }

    tlsSocket = tls.connect(
      {
        socket,
        servername: targetHost,
        rejectUnauthorized: true,
      },
      () => {
        tlsSocket.setTimeout(timeout, () => {
          cleanup();
          signalErr(new Error("Proxy TLS request timeout"));
        });

        const payload = body != null ? body : "";
        const hdrs = {
          ...headers,
          Host: urlObj.host,
          Connection: "close",
        };
        if (payload && !hdrs["Content-Length"] && !hdrs["content-length"]) {
          hdrs["Content-Length"] = Buffer.byteLength(payload);
        }
        const headerBlock =
          `${method} ${targetPath || "/"} HTTP/1.1\r\n` +
          Object.entries(hdrs)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n";
        tlsSocket.write(headerBlock);
        if (payload) tlsSocket.write(payload);

        let raw = "";
        const onData = (chunk) => {
          if (responseStarted) return;
          raw += chunk.toString("latin1");
          const sep = raw.indexOf("\r\n\r\n");
          if (sep === -1) return;
          responseStarted = true;
          tlsSocket.removeListener("data", onData);
          const head = raw.slice(0, sep);
          const rest = raw.slice(sep + 4);
          const statusLine = head.split("\r\n")[0] || "";
          const m = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
          const statusCode = m ? Number(m[1]) : 0;
          const headerLines = head.split("\r\n").slice(1);
          const outHeaders = {};
          for (const line of headerLines) {
            const idx = line.indexOf(":");
            if (idx > 0) outHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
          let ended = false;
          const fakeRes = {
            statusCode,
            headers: outHeaders,
            on(event, cb) {
              if (event === "data") {
                if (rest) cb(Buffer.from(rest, "latin1"));
                tlsSocket.on("data", cb);
              } else if (event === "end") {
                const endOnce = () => {
                  if (ended) return;
                  ended = true;
                  cb();
                };
                tlsSocket.on("end", endOnce);
                tlsSocket.on("close", endOnce);
              } else if (event === "error") {
                tlsSocket.on("error", cb);
              }
            },
          };
          signalDone(fakeRes);
        };
        tlsSocket.on("data", onData);
      }
    );

    tlsSocket.on("error", (err) => {
      cleanup();
      signalErr(err);
    });
  });

  connectReq.on("error", (err) => {
    cleanup();
    signalErr(err);
  });
  connectReq.on("timeout", () => {
    cleanup();
    signalErr(new Error("Proxy CONNECT timeout"));
  });
  connectReq.end();
}

function runHttpRequest(urlStr, { method = "GET", headers = {}, body = null, timeout = 120000, cleanupRef } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const isHttps = urlObj.protocol === "https:";
    const proxyUrl = getProxyUrlForHost(urlObj.hostname);
    const useProxy = proxyUrl && !shouldBypassProxy(urlObj.hostname);

    const signalDone = (res) => {
      readResponse(res)
        .then((text) => resolve({ statusCode: res.statusCode || 0, headers: res.headers || {}, text }))
        .catch(reject);
    };
    const signalErr = reject;
    const registerCleanup = (fn) => {
      if (cleanupRef) cleanupRef.current = fn;
    };

    if (useProxy) {
      proxyRequest(proxyUrl, urlObj, {
        method,
        headers,
        body,
        timeout,
        isHttps,
        signalDone,
        signalErr,
        registerCleanup,
      });
    } else {
      directRequest(urlObj, {
        method,
        headers,
        body,
        timeout,
        isHttps,
        signalDone,
        signalErr,
        registerCleanup,
      });
    }
  });
}

export function httpRequest(urlStr, options = {}) {
  const timeout = Number(options.timeout) || 120000;
  const cleanupRef = { current: () => {} };
  const work = runHttpRequest(urlStr, { ...options, timeout, cleanupRef });
  return withDeadline(work, timeout, () => cleanupRef.current());
}

export function httpGet(urlStr, headers = {}, timeout = 120000) {
  return httpRequest(urlStr, { method: "GET", headers, timeout });
}

export function httpPostJson(urlStr, payload, apiKey, timeout = 180000) {
  const body = JSON.stringify(payload);
  return httpRequest(urlStr, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    timeout,
  });
}

export function downloadToFile(urlStr, filepath, timeout = 300000) {
  return withDeadline(new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const isHttps = urlObj.protocol === "https:";
    const proxyUrl = getProxyUrlForHost(urlObj.hostname);
    const useProxy = proxyUrl && !shouldBypassProxy(urlObj.hostname);
    let cleanup = () => {};

    const pipeResponse = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadToFile(res.headers.location, filepath, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      if (typeof res.pipe === "function") {
        const file = fs.createWriteStream(filepath);
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => resolve());
        });
        file.on("error", (err) => {
          fs.unlink(filepath, () => reject(err));
        });
        return;
      }
      readResponseBinary(res)
        .then((buf) => fs.promises.writeFile(filepath, buf).then(resolve))
        .catch(reject);
    };

    if (useProxy && isHttps) {
      proxyRequest(proxyUrl, urlObj, {
        method: "GET",
        headers: {},
        body: null,
        timeout,
        isHttps: true,
        signalDone: pipeResponse,
        signalErr: reject,
        registerCleanup: (fn) => { cleanup = fn; },
      });
      return;
    }

    const transport = isHttps ? https : http;
    const req = transport.get(urlStr, (res) => pipeResponse(res));
    cleanup = () => {
      try { req.destroy(); } catch {}
    };
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("Download timeout"));
    });
  }), timeout, () => {});
}
