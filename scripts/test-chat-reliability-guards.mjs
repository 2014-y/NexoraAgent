import fs from 'node:fs';

function expectMatch(text, pattern, message) {
  if (!pattern.test(text)) throw new Error(message);
}

function expectNoMatch(text, pattern, message) {
  if (pattern.test(text)) throw new Error(message);
}

const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');

expectMatch(
  renderer,
  /\.agent-chat__composer-shell::before \{ content: none !important; display: none !important;/,
  'embedded OpenClaw composer must not render the oversized 2026.9 top shadow'
);
const gatewayPatch = fs.readFileSync(new URL('../patch_gateway.js', import.meta.url), 'utf8');
const rollover = fs.readFileSync(new URL('../plugins/session-overflow-rollover/index.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const latency = fs.readFileSync(new URL('../latency-tune.js', import.meta.url), 'utf8');

expectMatch(renderer, /if \(chatSendInFlight\)[\s\S]*previous message is still processing/, 'chat sends must be single-flight');
expectMatch(renderer, /chatSessionHistory\.splice\(historyStartLength\)/, 'failed chat turns must be rolled back');
expectMatch(renderer, /CHAT_HISTORY_STORAGE_KEY/, 'desktop chat context must have a bounded persistent store');
expectMatch(renderer, /localStorage\.removeItem\(CHAT_HISTORY_STORAGE_KEY\)/, 'clearing chat must clear persisted context');
expectMatch(renderer, /persistChatSessionHistory\(\);/, 'chat success/failure paths must persist or roll back context');
expectMatch(renderer, /finally \{[\s\S]*clearTimeout\(timeoutId\)[\s\S]*releaseChatSend\(\)/, 'chat timeout and UI state must be released');
expectMatch(renderer, /function compactChatSessionHistory[\s\S]*keptRecentImage/, 'chat history must bound retained image payloads');
expectMatch(renderer, /attachment: ''/, 'local archives must not persist base64 image payloads');
expectMatch(renderer, /resolveVisionChatModel\(\)/, 'image uploads must resolve a vision-capable chat model');

expectMatch(gatewayPatch, /function isRetrySafeFetchArgs/, 'gateway retries must classify request idempotency');
expectMatch(gatewayPatch, /if \(!retrySafe\) throw e;/, 'non-idempotent network failures must not be replayed');
expectMatch(gatewayPatch, /non-idempotent request was not replayed/, 'non-idempotent HTTP failures must be handed off without replay');

expectMatch(rollover, /function isOriginatingRouteValidationError/, 'rollover route fallback must be validation-only');
expectMatch(rollover, /delivery outcome uncertain; skipped duplicate retry notice/, 'uncertain chat delivery must not trigger another message');
expectNoMatch(rollover, /api\.on\(['"](?:shutdown|plugin_unload)['"]/, 'rollover must not register unsupported typed lifecycle hooks');

expectNoMatch(latency, /for \(const idle of \['slack', 'whatsapp', 'matrix', 'voice-call'\]/, 'latency tuning must not disable communication plugins');
expectNoMatch(main, /Pre-gateway missing bundled:[\s\S]{0,260}enabled = false/, 'missing bundled channels must preserve user state');
expectNoMatch(main, /official seed skipped:[\s\S]{0,360}enabled = false/, 'channel seed failures must preserve user state');

console.log('chat reliability guard tests passed');
