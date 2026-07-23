'use strict';
/**
 * 修复 / 防止 Gemini 等严格提供者拒绝的 tool 轮次断裂：
 * "Please ensure that function response turn comes immediately after a function call turn."
 *
 * 支持：
 * - OpenAI: assistant.tool_calls + role:tool|function
 * - 内容块: tool_use / toolCall / tool_result / toolResult
 * - OpenClaw session jsonl: { type:'message', message:{...} }
 *
 * 关键补丁：openai-completions 路径上 OpenClaw 关闭了 allowSyntheticToolResults，
 * 中断的 tool 轮会永久卡死会话；这里主动合成缺失的 tool 结果。
 */

function isToolResultRole(msg) {
    if (!msg || !msg.role) return false;
    const r = String(msg.role);
    // OpenClaw 会话原生: toolResult；OpenAI HTTP: tool/function
    return (
        r === 'tool' ||
        r === 'function' ||
        r === 'toolResult' ||
        r === 'tool_result'
    );
}

function contentParts(msg) {
    if (!msg) return [];
    return Array.isArray(msg.content) ? msg.content : [];
}

function partType(p) {
    return p && typeof p === 'object' ? String(p.type || '') : '';
}

function isToolUsePart(p) {
    const t = partType(p).toLowerCase();
    return (
        t === 'tool_use' ||
        t === 'tooluse' ||
        t === 'toolcall' ||
        t === 'tool_call' ||
        t === 'function_call' ||
        t === 'functioncall'
    );
}

function isToolResultPart(p) {
    const t = partType(p).toLowerCase();
    return t === 'tool_result' || t === 'toolresult' || t === 'function_result';
}

function toolUseId(p) {
    if (!p || typeof p !== 'object') return '';
    if (p.id != null) return String(p.id);
    if (p.toolCallId != null) return String(p.toolCallId);
    if (p.tool_call_id != null) return String(p.tool_call_id);
    return '';
}

function toolUseName(p) {
    if (!p || typeof p !== 'object') return '';
    if (typeof p.name === 'string') return p.name;
    if (p.function && typeof p.function.name === 'string') return p.function.name;
    return '';
}

function toolResultId(p) {
    if (!p || typeof p !== 'object') return '';
    if (p.tool_use_id != null) return String(p.tool_use_id);
    if (p.toolUseId != null) return String(p.toolUseId);
    if (p.tool_call_id != null) return String(p.tool_call_id);
    if (p.toolCallId != null) return String(p.toolCallId);
    if (p.id != null) return String(p.id);
    return '';
}

function assistantHasToolCalls(msg) {
    if (!msg || msg.role !== 'assistant') return false;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
    if (msg.function_call) return true;
    return contentParts(msg).some(isToolUsePart);
}

function isToolResultMessage(msg) {
    if (!msg) return false;
    if (isToolResultRole(msg)) return true;
    // Anthropic：纯 tool_result 内容块挂在 user 上
    if (msg.role === 'user') {
        const parts = contentParts(msg);
        return parts.length > 0 && parts.every(isToolResultPart);
    }
    return false;
}

function collectCallIds(msg) {
    const ids = new Set();
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (tc && tc.id != null) ids.add(String(tc.id));
        }
    }
    for (const p of contentParts(msg)) {
        if (isToolUsePart(p)) {
            const id = toolUseId(p);
            if (id) ids.add(id);
        }
    }
    return ids;
}

/** id → tool name（用于合成 OpenClaw toolResult） */
function collectCallNames(msg) {
    const map = new Map();
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (!tc || tc.id == null) continue;
            const name =
                (tc.function && tc.function.name) ||
                tc.name ||
                'unknown';
            map.set(String(tc.id), String(name));
        }
    }
    for (const p of contentParts(msg)) {
        if (!isToolUsePart(p)) continue;
        const id = toolUseId(p);
        if (!id) continue;
        map.set(id, toolUseName(p) || 'unknown');
    }
    return map;
}

function collectResultIds(msg) {
    const ids = new Set();
    if (!msg) return ids;
    // OpenClaw toolResult 消息顶层字段
    for (const k of ['tool_call_id', 'toolCallId', 'tool_use_id', 'toolUseId', 'call_id', 'callId']) {
        if (msg[k] != null) ids.add(String(msg[k]));
    }
    for (const p of contentParts(msg)) {
        if (isToolResultPart(p)) {
            const id = toolResultId(p);
            if (id) ids.add(id);
        }
    }
    return ids;
}

function stripToolCallsFromAssistant(msg) {
    const fixed = Object.assign({}, msg);
    delete fixed.tool_calls;
    delete fixed.function_call;
    if (Array.isArray(fixed.content)) {
        const kept = fixed.content.filter((p) => !isToolUsePart(p));
        const text = kept
            .map((p) => {
                if (typeof p === 'string') return p;
                if (p && typeof p.text === 'string') return p.text;
                return '';
            })
            .join('')
            .trim();
        fixed.content = text || '[上一轮工具调用已中断，已忽略]';
    } else if (fixed.content == null || fixed.content === '') {
        fixed.content = '[上一轮工具调用已中断，已忽略]';
    }
    return fixed;
}

/** OpenAI HTTP body 用 */
function makeSyntheticToolResult(callId) {
    return {
        role: 'tool',
        tool_call_id: String(callId || 'synthetic'),
        content:
            '{"ok":false,"error":"tool_interrupted","message":"Previous tool call was interrupted; synthetic result inserted to keep the conversation valid for Gemini."}',
    };
}

/** OpenClaw 会话 jsonl 原生格式（Google transport 只认 role:toolResult） */
function makeSyntheticOpenClawToolResult(callId, toolName) {
    return {
        role: 'toolResult',
        toolCallId: String(callId),
        toolName: toolName || 'unknown',
        isError: true,
        content: [{ type: 'text', text: 'tool_interrupted: synthetic result' }],
    };
}

/**
 * 完整修复：挪回错位结果 + 合成缺失结果 + 丢弃孤儿。
 * keptIndexes[i] 对应 messages[i] 的原下标；合成行用 -1。
 *
 * @param {object[]} messages
 * @returns {{ messages: object[], modified: boolean, keptIndexes: number[] }}
 */
function repairBrokenToolTurns(messages) {
    if (!Array.isArray(messages)) return { messages, modified: false, keptIndexes: [] };

    const work = messages.map((m, idx) => ({ msg: m, idx }));
    let modified = false;
    const out = [];
    const keptIndexes = [];
    const consumed = new Set();

    for (let i = 0; i < work.length; i++) {
        if (consumed.has(i)) continue;
        const item = work[i];
        const msg = item.msg;
        if (!msg || typeof msg !== 'object') {
            modified = true;
            continue;
        }

        if (isToolResultMessage(msg)) {
            modified = true;
            continue;
        }

        if (!assistantHasToolCalls(msg)) {
            out.push(msg);
            keptIndexes.push(item.idx);
            continue;
        }

        const callIds = collectCallIds(msg);
        const callNames = collectCallNames(msg);
        const hasOpenAiCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
        const hasContentCalls = contentParts(msg).some(isToolUsePart);

        const paired = [];
        let j = i + 1;
        while (j < work.length && !consumed.has(j) && isToolResultMessage(work[j].msg)) {
            const ids = collectResultIds(work[j].msg);
            const matches =
                callIds.size === 0 ||
                ids.size === 0 ||
                Array.from(ids).some((id) => callIds.has(id));
            if (!matches) break;
            paired.push(work[j]);
            consumed.add(j);
            j++;
        }

        if (callIds.size > 0) {
            for (let k = j; k < work.length; k++) {
                if (consumed.has(k)) continue;
                const m2 = work[k].msg;
                if (assistantHasToolCalls(m2)) break;
                if (!isToolResultMessage(m2)) continue;
                const ids = collectResultIds(m2);
                const match = Array.from(ids).some((id) => callIds.has(id));
                if (match) {
                    paired.push(work[k]);
                    consumed.add(k);
                    modified = true;
                }
            }
        }

        const got = new Set();
        for (const p of paired) {
            for (const id of collectResultIds(p.msg)) got.add(id);
        }

        const missing = [];
        if (callIds.size > 0) {
            for (const id of callIds) {
                if (!got.has(id)) missing.push(id);
            }
        }

        // 无任何 call id 时无法合成合法 Gemini function response → 降级剥掉 tool_calls
        if (callIds.size === 0 && paired.length === 0 && (hasOpenAiCalls || msg.function_call || hasContentCalls)) {
            modified = true;
            out.push(stripToolCallsFromAssistant(msg));
            keptIndexes.push(item.idx);
            continue;
        }

        out.push(msg);
        keptIndexes.push(item.idx);
        for (const p of paired) {
            out.push(p.msg);
            keptIndexes.push(p.idx);
        }

        if (missing.length > 0) {
            modified = true;
            // OpenClaw 会话：必须合成 role:toolResult（绝不能塞 Anthropic user/tool_result，否则会污染健康会话）
            // OpenAI HTTP：合成 role:tool
            if (hasContentCalls && !hasOpenAiCalls) {
                for (const id of missing) {
                    out.push(makeSyntheticOpenClawToolResult(id, callNames.get(id)));
                    keptIndexes.push(-1);
                }
            } else {
                for (const id of missing) {
                    out.push(makeSyntheticToolResult(id));
                    keptIndexes.push(-1);
                }
            }
        }
    }

    // 扫尾：去掉夹在普通对话里的残留 tool_result 内容块（否则 Gemini 仍可能 400）
    const cleaned = [];
    const cleanedIdx = [];
    for (let i = 0; i < out.length; i++) {
        const msg = out[i];
        const prev = cleaned.length ? cleaned[cleaned.length - 1] : null;
        if (
            msg &&
            msg.role === 'user' &&
            contentParts(msg).some(isToolResultPart) &&
            !(prev && assistantHasToolCalls(prev))
        ) {
            const parts = contentParts(msg);
            const keptParts = parts.filter((p) => !isToolResultPart(p));
            if (keptParts.length === 0) {
                modified = true;
                continue;
            }
            if (keptParts.length !== parts.length) {
                modified = true;
                const copy = Object.assign({}, msg, { content: keptParts });
                cleaned.push(copy);
                cleanedIdx.push(keptIndexes[i]);
                continue;
            }
        }
        cleaned.push(msg);
        cleanedIdx.push(keptIndexes[i]);
    }

    if (!modified) {
        return { messages, modified: false, keptIndexes: messages.map((_, idx) => idx) };
    }
    return { messages: cleaned, modified: true, keptIndexes: cleanedIdx };
}

/**
 * 从尾部保留最近 N 条会话行时，对齐 tool 配对，并写入合成行。
 * 保持非 message 行与 message 行的相对槽位顺序（与 healSessionTranscriptFile 一致）。
 */
function sliceSessionLinesKeepingToolPairs(lines, keepCount) {
    if (!Array.isArray(lines) || lines.length === 0) return { lines: lines || [], modified: false };
    const n = Math.max(1, Number(keepCount) || 30);
    let modified = false;
    let start = lines.length <= n ? 0 : lines.length - n;
    const getMsg = (line) => (line && line.type === 'message' ? line.message : null);

    if (start > 0) {
        while (start > 0) {
            const msg = getMsg(lines[start]);
            if (msg && isToolResultMessage(msg)) {
                start -= 1;
                modified = true;
                continue;
            }
            break;
        }
        if (start > 0) {
            const prev = getMsg(lines[start - 1]);
            const cur = getMsg(lines[start]);
            if (prev && assistantHasToolCalls(prev) && cur && isToolResultMessage(cur)) {
                start -= 1;
                modified = true;
            }
        }
    }

    const sliced = start > 0 ? lines.slice(start) : lines.slice();
    if (start > 0) modified = true;

    const msgs = [];
    for (let i = 0; i < sliced.length; i++) {
        const m = getMsg(sliced[i]);
        if (m) msgs.push(m);
    }
    if (msgs.length === 0) return { lines: sliced, modified };

    const repaired = repairBrokenToolTurns(msgs);
    if (!repaired.modified) return { lines: sliced, modified };

    const newMsgLines = repaired.messages.map((m, idx) => {
        const old = repaired.keptIndexes[idx];
        const base =
            old != null && old >= 0 && msgs[old]
                ? (() => {
                      // 找到原 sliced 中对应 message 行
                      let seen = -1;
                      for (let i = 0; i < sliced.length; i++) {
                          if (!getMsg(sliced[i])) continue;
                          seen += 1;
                          if (seen === old) return sliced[i];
                      }
                      return { type: 'message' };
                  })()
                : { type: 'message' };
        return Object.assign({}, base, { message: m });
    });

    let qi = 0;
    const out = [];
    for (const line of sliced) {
        if (!getMsg(line)) {
            out.push(line);
            continue;
        }
        if (qi < newMsgLines.length) {
            out.push(newMsgLines[qi++]);
        }
        // 多余的旧 message 槽位丢弃（被 repair 合并/删除）
    }
    while (qi < newMsgLines.length) {
        out.push(newMsgLines[qi++]);
    }
    return { lines: out, modified: true };
}

/**
 * 修复 OpenClaw session *.jsonl 文件（就地写回，先 .bak）。
 */
function healSessionTranscriptFile(filePath, fsMod) {
    const fs = fsMod || require('fs');
    if (!filePath || !fs.existsSync(filePath)) return { changed: false, reason: 'missing' };
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return { changed: false, reason: 'read-fail' };
    }
    if (!raw.trim()) return { changed: false, reason: 'empty' };

    const rawLines = raw.split(/\r?\n/);
    const meta = [];
    for (const text of rawLines) {
        if (!text.trim()) {
            meta.push({ kind: 'blank', text });
            continue;
        }
        try {
            const obj = JSON.parse(text);
            meta.push({ kind: 'obj', obj });
        } catch (e) {
            meta.push({ kind: 'raw', text });
        }
    }

    const messageEntries = [];
    for (const item of meta) {
        if (item.kind === 'obj' && item.obj && item.obj.type === 'message' && item.obj.message) {
            messageEntries.push(item);
        }
    }
    if (messageEntries.length === 0) return { changed: false, reason: 'no-messages' };

    const msgs = messageEntries.map((e) => e.obj.message);
    const repaired = repairBrokenToolTurns(msgs);
    if (!repaired.modified) return { changed: false, reason: 'clean' };

    const keepMsgs = repaired.messages;
    const newMessageObjs = keepMsgs.map((m, idx) => {
        const oldIdx = repaired.keptIndexes[idx];
        const base =
            oldIdx != null && oldIdx >= 0 && messageEntries[oldIdx]
                ? messageEntries[oldIdx].obj
                : { type: 'message', timestamp: Date.now() };
        return Object.assign({}, base, { message: m });
    });

    let msgOut = 0;
    const outLines = [];
    for (const item of meta) {
        if (item.kind === 'blank') continue;
        if (item.kind === 'raw') {
            outLines.push(item.text);
            continue;
        }
        if (item.obj && item.obj.type === 'message') {
            if (msgOut < newMessageObjs.length) {
                outLines.push(JSON.stringify(newMessageObjs[msgOut++]));
            }
            continue;
        }
        outLines.push(JSON.stringify(item.obj));
    }
    while (msgOut < newMessageObjs.length) {
        outLines.push(JSON.stringify(newMessageObjs[msgOut++]));
    }

    try {
        fs.copyFileSync(filePath, `${filePath}.bak-toolheal-${Date.now()}`);
        fs.writeFileSync(filePath, outLines.join('\n') + '\n', 'utf8');
    } catch (e) {
        return { changed: false, reason: 'write-fail' };
    }
    return { changed: true, reason: 'repaired', before: msgs.length, after: keepMsgs.length };
}

function healAllSessionTranscripts(stateDir, fsMod, pathMod) {
    const fs = fsMod || require('fs');
    const path = pathMod || require('path');
    const agentsRoot = path.join(stateDir, 'agents');
    const summary = { scanned: 0, healed: 0, files: [] };
    if (!fs.existsSync(agentsRoot)) return summary;
    let agents;
    try {
        agents = fs.readdirSync(agentsRoot);
    } catch (e) {
        return summary;
    }
    for (const agent of agents) {
        const sessionsDir = path.join(agentsRoot, agent, 'sessions');
        if (!fs.existsSync(sessionsDir)) continue;
        let names;
        try {
            names = fs.readdirSync(sessionsDir);
        } catch (e) {
            continue;
        }
        for (const name of names) {
            if (!/\.jsonl$/i.test(name)) continue;
            if (/bak/i.test(name)) continue;
            const full = path.join(sessionsDir, name);
            summary.scanned += 1;
            const r = healSessionTranscriptFile(full, fs);
            if (r.changed) {
                summary.healed += 1;
                summary.files.push(full);
            }
        }
    }
    return summary;
}

function looksLikeToolPairFormatError(errText) {
    const s = String(errText || '');
    if (/function response turn comes immediately after a function call turn/i.test(s)) return true;
    if (/provider rejected the request schema or tool payload/i.test(s)) return true;
    if (/Please ensure that function response/i.test(s)) return true;
    if (/INVALID_ARGUMENT/i.test(s) && /function/i.test(s)) return true;
    if (/MALFORMED_FUNCTION_CALL/i.test(s) || /UNEXPECTED_TOOL_CALL/i.test(s)) return true;
    if (/Provider finish_reason:\s*MALFORMED/i.test(s)) return true;
    if (/\(format\)/i.test(s) && /tool|function|schema|payload/i.test(s)) return true;
    if (/reason[=:\s]+format\b/i.test(s)) return true;
    if (/FailoverError/i.test(s) && /tool payload|schema|function response|\bformat\b|MALFORMED/i.test(s)) return true;
    return false;
}

module.exports = {
    repairBrokenToolTurns,
    sliceSessionLinesKeepingToolPairs,
    healSessionTranscriptFile,
    healAllSessionTranscripts,
    looksLikeToolPairFormatError,
    assistantHasToolCalls,
    isToolResultMessage,
    isToolResultRole,
    makeSyntheticToolResult,
    makeSyntheticOpenClawToolResult,
};
