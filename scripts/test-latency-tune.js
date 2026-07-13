'use strict';
const { ensureLatencySafeConfig, DEFAULTS } = require('../latency-tune');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed += 1;
  console.log('OK:', msg);
}

const slow = {
  channels: {
    'openclaw-weixin': { inbound: { debounceMs: 2000 } }
  },
  agents: {
    defaults: {
      bootstrapMaxChars: 20000,
      bootstrapTotalMaxChars: 60000,
      humanDelay: { enabled: true }
    }
  },
  models: {
    providers: {
      ollama: {
        baseUrl: 'http://localhost:11434/v1',
        models: [
          {
            id: 'jarvis-learned',
            contextWindow: 4718592,
            maxTokens: 4096
          }
        ]
      },
      'agnes-ai': {
        models: [{ id: 'agnes-2.0-flash', contextWindow: 1048576 }]
      }
    }
  },
  plugins: {
    entries: {
      'dual-model-trainer': {
        enabled: true,
        config: { mode: 'teach-learn', enableTeachLearn: true, timeoutMs: 60000 }
      }
    }
  }
};

const { config, changed, changes } = ensureLatencySafeConfig(slow);
assert(changed === true, 'slow config marked changed');
assert(config.channels['openclaw-weixin'].inbound.debounceMs === DEFAULTS.weixinDebounceMs, 'weixin debounce capped');
assert(config.agents.defaults.bootstrapMaxChars === DEFAULTS.bootstrapMaxChars, 'bootstrapMaxChars capped');
assert(config.agents.defaults.bootstrapTotalMaxChars === DEFAULTS.bootstrapTotalMaxChars, 'bootstrapTotalMaxChars capped');
assert(config.agents.defaults.humanDelay.enabled === false, 'humanDelay disabled');
assert(config.models.providers.ollama.models[0].contextWindow === DEFAULTS.ollamaContextWindow, 'ollama contextWindow capped');
assert(config.models.providers.ollama.models[0].maxTokens === DEFAULTS.ollamaMaxTokens, 'ollama maxTokens capped');
assert(config.models.providers.ollama.models[0].params.num_ctx === DEFAULTS.ollamaNumCtx, 'ollama num_ctx set');
assert(config.models.providers.ollama.models[0].params.thinking === false, 'ollama thinking off');
assert(config.models.providers.ollama.models[0].compat.supportsTools === false, 'ollama tools off');
assert(config.models.providers['agnes-ai'].models[0].contextWindow === DEFAULTS.cloudContextWindowCap, 'cloud contextWindow capped');
assert(config.tools.byProvider.ollama.profile === 'minimal', 'ollama tools profile minimal');
assert(config.tools.deny.includes('tts'), 'tts denied');
assert(config.plugins.entries['dual-model-trainer'].config.mode === 'collect-only', 'dual-model collect-only');
assert(config.plugins.entries['dual-model-trainer'].config.enableTeachLearn === false, 'teach-learn disabled');
assert(config.plugins.entries['dual-model-trainer'].config.timeoutMs === 20000, 'dual-model timeout capped');
assert(changes.length >= 8, `logged ${changes.length} changes`);

const again = ensureLatencySafeConfig(config);
assert(again.changed === false, 'idempotent on already-tuned config');

console.log(`\n${passed} passed`);
