'use strict';
/**
 * Nexora 数据中心 API（源自 openclaw-dashboard，1:1 能力搬迁）
 * - 读取 ~/.openclaw（或 OPENCLAW_STATE_DIR）下的 SQLite 状态库
 * - 既可独立 `node data-center/server.js`，也可被 Electron main 调用 start()
 *
 * 读库策略：
 * 1) 优先 node:sqlite（WAL 友好，Electron/新 Node 可用时）
 * 2) 回退 sql.js 文件快照（带重试）；查询失败抛错，不再伪装成空表
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');

function resolveStateRoot(explicit) {
  const cands = [
    explicit,
    process.env.OPENCLAW_STATE_DIR,
    process.env.NEXORA_OPENCLAW_STATE_DIR,
    path.join(process.env.OPENCLAW_HOME || '', '.openclaw'),
    path.join(os.homedir(), '.openclaw'),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return path.join(os.homedir(), '.openclaw');
}

function resolveDbPaths(stateRoot) {
  const stateCandidates = [
    path.join(stateRoot, 'state', 'openclaw.sqlite'),
    path.join(stateRoot, 'openclaw.sqlite'),
  ];
  const agentCandidates = [
    path.join(stateRoot, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'),
    path.join(stateRoot, 'agents', 'main', 'openclaw-agent.sqlite'),
  ];
  const pick = (list) => {
    for (const p of list) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (_) {}
    }
    return list[0];
  };
  return {
    state: pick(stateCandidates),
    agent: pick(agentCandidates),
  };
}

function sleepSync(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  } catch (_) {
    const end = Date.now() + n;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

function tryLoadNativeSqlite() {
  try {
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return mod.DatabaseSync;
  } catch (_) {}
  return null;
}

function createApp(options = {}) {
  const stateRoot = resolveStateRoot(options.stateDir);
  const DB_PATHS = resolveDbPaths(stateRoot);
  const app = express();
  app.use(cors());
  app.use(express.static(path.join(__dirname, 'public')));

  let SQL = options.SQL || null;
  const NativeDatabaseSync = options.forceSqlJs ? null : tryLoadNativeSqlite();
  const dbEngine = NativeDatabaseSync ? 'node:sqlite' : 'sql.js';

  function openNativeDb(file) {
    // 不用 readOnly：WAL 库在只读时可能因无法映射 -shm 而失败
    return new NativeDatabaseSync(file, { timeout: 5000 });
  }

  function openSqlJsDb(file) {
    if (!SQL) throw new Error('sql.js not initialized');
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const buf = fs.readFileSync(file);
        return new SQL.Database(buf);
      } catch (e) {
        lastErr = e;
        sleepSync(40 * (attempt + 1));
      }
    }
    throw lastErr || new Error('failed to open database via sql.js');
  }

  function openDb(key) {
    const file = DB_PATHS[key];
    if (!file || !fs.existsSync(file)) {
      throw new Error('database missing: ' + (file || key));
    }
    if (NativeDatabaseSync) {
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return { engine: 'native', db: openNativeDb(file) };
        } catch (e) {
          lastErr = e;
          sleepSync(40 * (attempt + 1));
        }
      }
      throw lastErr || new Error('failed to open database via node:sqlite');
    }
    return { engine: 'sqljs', db: openSqlJsDb(file) };
  }

  function closeHandle(handle) {
    try {
      if (handle && handle.db && typeof handle.db.close === 'function') handle.db.close();
    } catch (_) {}
  }

  function queryNative(db, sql, params) {
    const stmt = db.prepare(sql);
    try {
      if (params && params.length) return stmt.all(...params);
      return stmt.all();
    } finally {
      try {
        if (typeof stmt.finalize === 'function') stmt.finalize();
      } catch (_) {}
    }
  }

  function querySqlJs(db, sql, params) {
    if (!params || !params.length) {
      const result = db.exec(sql);
      if (!result.length) return [];
      return result[0].values.map((row) => {
        const obj = {};
        result[0].columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        return obj;
      });
    }
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      try {
        stmt.free();
      } catch (_) {}
    }
  }

  /** @throws on open/query failure — callers must not treat failures as empty tables */
  function query(dbKey, sql, params) {
    const handle = openDb(dbKey);
    try {
      if (handle.engine === 'native') return queryNative(handle.db, sql, params);
      return querySqlJs(handle.db, sql, params);
    } finally {
      closeHandle(handle);
    }
  }

  function sendRows(res, run) {
    try {
      const rows = run();
      res.json(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.error('[DataCenter] Query error:', e && e.message ? e.message : e);
      res.status(503).json({
        ok: false,
        error: e && e.message ? String(e.message) : String(e),
      });
    }
  }

  app.get('/api/health', (_req, res) => {
    let dbReadable = false;
    let dbError = null;
    try {
      query('state', 'SELECT 1 AS ok');
      dbReadable = true;
    } catch (e) {
      dbError = e && e.message ? String(e.message) : String(e);
    }
    res.json({
      ok: true,
      dbReadable,
      dbError,
      dbEngine,
      stateRoot,
      databases: {
        state: { path: DB_PATHS.state, exists: fs.existsSync(DB_PATHS.state) },
        agent: { path: DB_PATHS.agent, exists: fs.existsSync(DB_PATHS.agent) },
      },
    });
  });

  app.get('/api/gateway/boots', (_req, res) => {
    sendRows(res, () =>
      query(
        'state',
        `SELECT boot_id, pid, started_at_ms, completed_at_ms, outcome, startup_reason, reason
         FROM gateway_boot_lifecycle ORDER BY started_at_ms DESC LIMIT 50`
      )
    );
  });

  app.get('/api/cron/jobs', (_req, res) => {
    sendRows(res, () =>
      query(
        'state',
        `SELECT job_id, name, enabled, schedule_kind, schedule_expr, every_ms,
                next_run_at_ms, last_run_at_ms, last_run_status, last_duration_ms,
                consecutive_errors, delivery_channel, delivery_to
         FROM cron_jobs ORDER BY name`
      )
    );
  });

  app.get('/api/cron/runs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    sendRows(res, () =>
      query(
        'state',
        `SELECT job_id, seq, ts, status, error, summary, delivery_status,
                model, provider, total_tokens, duration_ms
         FROM cron_run_logs ORDER BY ts DESC LIMIT ?`,
        [limit]
      )
    );
  });

  app.get('/api/audit/events', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    sendRows(res, () =>
      query(
        'state',
        `SELECT sequence, occurred_at, kind, action, status, agent_id,
                session_key, tool_name
         FROM audit_events ORDER BY occurred_at DESC LIMIT ?`,
        [limit]
      )
    );
  });

  app.get('/api/audit/stats', (_req, res) => {
    sendRows(res, () =>
      query(
        'state',
        `SELECT kind, action, status, count(*) as cnt
         FROM audit_events GROUP BY kind, action, status ORDER BY cnt DESC`
      )
    );
  });

  app.get('/api/audit/tools', (_req, res) => {
    sendRows(res, () =>
      query(
        'state',
        `SELECT tool_name, count(*) as cnt, status
         FROM audit_events WHERE tool_name IS NOT NULL
         GROUP BY tool_name, status ORDER BY cnt DESC`
      )
    );
  });

  app.get('/api/delivery/queue', (_req, res) => {
    sendRows(res, () =>
      query(
        'state',
        `SELECT id, status, channel, target, account_id, retry_count,
                last_error, enqueued_at, updated_at, failed_at
         FROM delivery_queue_entries ORDER BY enqueued_at DESC LIMIT 100`
      )
    );
  });

  app.get('/api/models/catalog', (_req, res) => {
    sendRows(res, () => {
      const rows = query('state', `SELECT raw_json FROM agent_model_catalogs LIMIT 1`);
      if (rows.length && rows[0].raw_json) {
        try {
          const catalog = JSON.parse(rows[0].raw_json);
          return catalog.entries || [];
        } catch {
          return [];
        }
      }
      return [];
    });
  });

  app.get('/api/tokens/trend', (_req, res) => {
    sendRows(res, () =>
      query(
        'state',
        `SELECT 
           CAST((ts / 3600000) * 3600000 AS INTEGER) as hour_ms,
           SUM(total_tokens) as tokens,
           COUNT(*) as runs,
           model
         FROM cron_run_logs
         WHERE total_tokens > 0
         GROUP BY hour_ms, model
         ORDER BY hour_ms DESC
         LIMIT 500`
      )
    );
  });

  app.get('/api/audit/trend', (_req, res) => {
    sendRows(res, () =>
      query(
        'state',
        `SELECT 
           CAST((occurred_at / 3600000) * 3600000 AS INTEGER) as hour_ms,
           kind, count(*) as cnt
         FROM audit_events
         GROUP BY hour_ms, kind
         ORDER BY hour_ms DESC
         LIMIT 500`
      )
    );
  });

  app.get('/api/plugins', (_req, res) => {
    sendRows(res, () =>
      query(
        'state',
        `SELECT plugin_id, name, count(*) as entry_count
         FROM plugin_state_entries GROUP BY plugin_id, name`
      )
    );
  });

  app.get('/api/overview', (_req, res) => {
    try {
      const auditCount = query('state', `SELECT count(*) as cnt FROM audit_events`);
      const cronJobs = query('state', `SELECT count(*) as cnt FROM cron_jobs WHERE enabled=1`);
      const cronRuns = query('state', `SELECT count(*) as cnt FROM cron_run_logs`);
      const cronErrors = query('state', `SELECT count(*) as cnt FROM cron_run_logs WHERE status != 'ok'`);
      const deliveryFailed = query(
        'state',
        `SELECT count(*) as cnt FROM delivery_queue_entries WHERE status='failed'`
      );
      const totalTokens = query(
        'state',
        `SELECT SUM(total_tokens) as total FROM cron_run_logs WHERE total_tokens > 0`
      );
      const gatewayBoots = query('state', `SELECT count(*) as cnt FROM gateway_boot_lifecycle`);
      const toolCalls = query(
        'state',
        `SELECT count(*) as cnt FROM audit_events WHERE tool_name IS NOT NULL`
      );

      res.json({
        ok: true,
        auditEvents: (auditCount[0] && auditCount[0].cnt) || 0,
        cronJobsActive: (cronJobs[0] && cronJobs[0].cnt) || 0,
        cronRunsTotal: (cronRuns[0] && cronRuns[0].cnt) || 0,
        cronErrors: (cronErrors[0] && cronErrors[0].cnt) || 0,
        deliveryFailed: (deliveryFailed[0] && deliveryFailed[0].cnt) || 0,
        totalTokens: (totalTokens[0] && totalTokens[0].total) || 0,
        gatewayBoots: (gatewayBoots[0] && gatewayBoots[0].cnt) || 0,
        toolCalls: (toolCalls[0] && toolCalls[0].cnt) || 0,
      });
    } catch (e) {
      console.error('[DataCenter] Overview error:', e && e.message ? e.message : e);
      res.status(503).json({
        ok: false,
        error: e && e.message ? String(e.message) : String(e),
      });
    }
  });

  app.get('/api/status', (_req, res) => {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const sysMem = { total: os.totalmem(), free: os.freemem() };
    const cpus = os.cpus();
    res.json({
      serverUptime: uptime,
      nodeVersion: process.version,
      platform: os.platform(),
      hostname: os.hostname(),
      memoryUsage: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      systemMemory: sysMem,
      cpuCount: cpus.length,
      cpuModel: (cpus[0] && cpus[0].model) || 'unknown',
      timestamp: Date.now(),
      stateRoot,
      dbEngine,
    });
  });

  return {
    app,
    async initSql() {
      if (NativeDatabaseSync) return null;
      if (!SQL) {
        const initSqlJs = require('sql.js');
        SQL = await initSqlJs();
      }
      return SQL;
    },
    getDbPaths: () => ({ ...DB_PATHS }),
    getStateRoot: () => stateRoot,
    getDbEngine: () => dbEngine,
  };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  const base = Number(preferred) > 0 ? Number(preferred) : 3210;
  for (let i = 0; i < 30; i++) {
    const p = base + i;
    if (await isPortFree(p)) return p;
  }
  return 0;
}

/**
 * @param {{ stateDir?: string, preferredPort?: number }} [options]
 * @returns {Promise<{ server: import('http').Server, port: number, url: string, stateRoot: string }>}
 */
async function start(options = {}) {
  const created = createApp(options);
  await created.initSql();
  const port = await pickPort(options.preferredPort || 3210);
  if (!port) throw new Error('no free port for data-center');

  const server = http.createServer(created.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const url = `http://127.0.0.1:${port}/`;
  console.log(
    `[DataCenter] running at ${url} state=${created.getStateRoot()} engine=${created.getDbEngine()}`
  );
  return {
    server,
    port,
    url,
    stateRoot: created.getStateRoot(),
    dbPaths: created.getDbPaths(),
    dbEngine: created.getDbEngine(),
  };
}

module.exports = {
  createApp,
  start,
  resolveStateRoot,
  resolveDbPaths,
};

if (require.main === module) {
  start({ preferredPort: 3210 }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
