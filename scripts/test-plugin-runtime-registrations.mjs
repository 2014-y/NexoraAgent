import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tempState = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-plugin-hooks-'));
process.env.OPENCLAW_STATE_DIR = tempState;

async function collectHooks(relativePath, config = {}) {
  const url = pathToFileURL(path.resolve(relativePath)).href + `?test=${Date.now()}-${Math.random()}`;
  const entry = (await import(url)).default;
  assert.equal(typeof entry?.register, 'function', `${relativePath} must export a current OpenClaw plugin entry`);
  const hooks = new Map();
  entry.register({
    config,
    pluginConfig: {},
    runtime: { llm: { complete: async () => ({ content: 'ok' }) } },
    logger: console,
    on(name, handler) { hooks.set(name, handler); },
  });
  return hooks;
}

try {
  const summary = await collectHooks('plugins/auto-summary/index.js');
  assert.deepEqual([...summary.keys()].sort(), ['agent_end', 'gateway_stop']);

  const rotate = await collectHooks('plugins/memory-rotate/index.js');
  assert.deepEqual([...rotate.keys()].sort(), ['agent_end', 'gateway_stop']);

  const guard = await collectHooks('plugins/compaction-memory-guard/index.js');
  assert.deepEqual([...guard.keys()].sort(), ['after_compaction', 'gateway_stop']);

  const trainer = await collectHooks('plugins/dual-model-trainer/index.js', {
    agents: { defaults: { model: { primary: 'agnes-ai/test-model' } } },
    plugins: { entries: { 'dual-model-trainer': { config: { mode: 'collect-only' } } } },
  });
  assert.deepEqual([...trainer.keys()].sort(), ['agent_end', 'gateway_stop']);

  console.log('plugin runtime registration tests passed');
} finally {
  fs.rmSync(tempState, { recursive: true, force: true });
}
