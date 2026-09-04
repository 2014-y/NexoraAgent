import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { createApp } = require('../data-center/server.js');
const dataCenterUi = fs.readFileSync(new URL('../data-center/public/index.html', import.meta.url), 'utf8');
assert.match(dataCenterUi, /_activeFetchControllers: new Set\(\)/, 'data-center must track in-flight fetches');
assert.match(dataCenterUi, /onHiddenPause\(\)/, 'data-center must pause polling when hidden');
assert.match(dataCenterUi, /nexora-data-center-visibility/, 'parent must control data-center polling visibility');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-data-center-test-'));
const stateDir = path.join(tempRoot, 'state');
fs.mkdirSync(stateDir, { recursive: true });
const db = new DatabaseSync(path.join(stateDir, 'openclaw.sqlite'));

db.exec(`
  CREATE TABLE audit_events (sequence INTEGER PRIMARY KEY, occurred_at INTEGER, kind TEXT, action TEXT, status TEXT, agent_id TEXT, session_key TEXT, tool_name TEXT);
  CREATE TABLE cron_jobs (store_key TEXT, job_id TEXT, name TEXT, enabled INTEGER, payload_kind TEXT, job_json TEXT, state_json TEXT, sort_order INTEGER, PRIMARY KEY(store_key, job_id));
  CREATE TABLE task_runs (task_id TEXT PRIMARY KEY, runtime TEXT, source_id TEXT, created_at INTEGER, started_at INTEGER, ended_at INTEGER, status TEXT, error TEXT, terminal_summary TEXT, delivery_status TEXT, detail_json TEXT);
  CREATE TABLE delivery_queue_entries (queue_name TEXT, id TEXT, status TEXT, channel TEXT, target TEXT, account_id TEXT, retry_count INTEGER, last_error TEXT, entry_json TEXT, enqueued_at INTEGER, updated_at INTEGER, failed_at INTEGER, PRIMARY KEY(queue_name, id));
  CREATE TABLE gateway_boot_lifecycle (boot_id TEXT PRIMARY KEY, pid INTEGER, started_at_ms INTEGER, completed_at_ms INTEGER, outcome TEXT, startup_reason TEXT, reason TEXT);
  CREATE TABLE plugin_state_entries (plugin_id TEXT, namespace TEXT);
`);
db.prepare(`INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'jobs.json', 'heartbeat', 'heartbeat-main', 1, 'heartbeat',
  JSON.stringify({ schedule: { kind: 'every', everyMs: 1800000 } }),
  JSON.stringify({ lastRunAtMs: 1000, lastRunStatus: 'skipped', lastDurationMs: 12, consecutiveErrors: 0 }),
  0
);
db.prepare(`INSERT INTO task_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'run-1', 'cron', 'heartbeat', 1000, 1000, 1012, 'failed', 'skipped', null, 'not_applicable',
  JSON.stringify({ status: 'skipped', durationMs: 12 })
);
db.prepare(`INSERT INTO gateway_boot_lifecycle VALUES (?, ?, ?, ?, ?, ?, ?)`).run('boot-1', 1, 1000, 1010, 'ready', null, null);
db.close();

fs.writeFileSync(path.join(tempRoot, 'openclaw.json'), JSON.stringify({
  models: { providers: { demo: { api: 'openai-completions', models: [{ id: 'demo-model' }] } } },
}));

const created = createApp({ stateDir: tempRoot, accessToken: 'test-token' });
await created.initSql();
const server = http.createServer(created.app);

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api`;
  const get = async (route) => {
    const response = await fetch(base + route, { headers: { 'X-Nexora-Token': 'test-token' } });
    assert.equal(response.status, 200, `${route} should remain available on the 2026.9 schema`);
    return response.json();
  };

  const overview = await get('/overview');
  const jobs = await get('/cron/jobs');
  const runs = await get('/cron/runs');
  const models = await get('/models/catalog');
  await get('/tokens/trend');

  assert.equal(overview.cronJobsActive, 1);
  assert.equal(overview.cronRunsTotal, 1);
  assert.equal(overview.cronErrors, 0, 'skipped jobs are not failures');
  assert.equal(jobs[0].schedule_kind, 'every');
  assert.equal(jobs[0].last_run_status, 'skipped');
  assert.equal(runs[0].status, 'skipped');
  assert.equal(models[0].id, 'demo-model');
  assert.equal(models[0].provider, 'demo');
  console.log('data center OpenClaw 2026.9 schema tests passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
