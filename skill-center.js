'use strict';
/**
 * Nexora 技能中心：本地 workspace skills + OpenClaw Skill Workshop 提案审核。
 * 模型只创建 pending 提案；面板审核通过后才写入 SKILL.md 并启用。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PROTECTED_SKILLS = new Set(['image-generator', 'video-generator']);
const SKILL_WORKSHOP_GUIDANCE_MARKER = '<!-- nexora-skill-workshop-v1 -->';

/** 无实质说明的技能/提案不展示 */
function hasMeaningfulDescription(text) {
    const s = String(text || '').trim();
    if (s.length < 8) return false;
    if (/^[>\-_=#*`~.|·•\s]+$/.test(s)) return false;
    if (/^---/.test(s)) return false;
    if (/^(todo|tbd|n\/a|none|null|undefined)$/i.test(s)) return false;
    return true;
}

function parseFrontmatter(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        meta[key] = val;
    }
    return { meta, body: m[2] || '' };
}

function buildSkillMd({ name, description, body }) {
    const desc = String(description || '').trim() || String(name || 'skill');
    const content = String(body || '').trim() || `# ${name}\n\n（在此编写技能说明）\n`;
    return `---\nname: ${JSON.stringify(String(name))}\ndescription: ${JSON.stringify(desc)}\n---\n\n${content}\n`;
}

function stripProposalOnlyFrontmatter(raw) {
    const { meta, body } = parseFrontmatter(raw);
    delete meta.status;
    delete meta.version;
    delete meta.date;
    const name = meta.name || 'skill';
    const description = meta.description || name;
    return buildSkillMd({ name, description, body });
}

function walkSkillMdFiles(root, maxDepth = 6, depth = 0, out = []) {
    if (!root || depth > maxDepth || !fs.existsSync(root)) return out;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
    for (const ent of entries) {
        if (!ent || !ent.name || ent.name.startsWith('.')) continue;
        const full = path.join(root, ent.name);
        if (ent.isDirectory()) {
            walkSkillMdFiles(full, maxDepth, depth + 1, out);
            continue;
        }
        if (!ent.isFile()) continue;
        const lower = ent.name.toLowerCase();
        if (lower === 'skill.md' || lower === 'skills.md') out.push(full);
    }
    return out;
}

function createSkillCenter(deps) {
    const getConfigDir = () => deps.getConfigDir();
    const getConfigPath = () => deps.getConfigPath();
    const resolveNode = () => (typeof deps.resolveNode === 'function' ? deps.resolveNode() : 'node');
    const resolveOpenClawCli = () => (typeof deps.resolveOpenClawCli === 'function' ? deps.resolveOpenClawCli() : null);

    function workspaceSkillsDir() {
        return path.join(getConfigDir(), 'workspace', 'skills');
    }

    function workshopRoot() {
        return path.join(getConfigDir(), 'skill-workshop');
    }

    function readJsonSafe(filePath, fallback) {
        try {
            if (!fs.existsSync(filePath)) return fallback;
            return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
        } catch (e) {
            return fallback;
        }
    }

    function writeJsonSafe(filePath, data) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }

    function readOpenClawConfig() {
        try {
            const p = getConfigPath();
            if (!fs.existsSync(p)) return {};
            return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
        } catch (e) {
            return {};
        }
    }

    function writeOpenClawConfig(config) {
        writeJsonSafe(getConfigPath(), config);
    }

    function ensureWorkshopConfig(config) {
        let changed = false;
        const cfg = config && typeof config === 'object' ? config : {};
        if (!cfg.skills || typeof cfg.skills !== 'object') { cfg.skills = {}; changed = true; }
        if (!cfg.skills.workshop || typeof cfg.skills.workshop !== 'object') {
            cfg.skills.workshop = {};
            changed = true;
        }
        if (cfg.skills.workshop.approvalPolicy !== 'pending') {
            cfg.skills.workshop.approvalPolicy = 'pending';
            changed = true;
        }
        if (!cfg.skills.workshop.autonomous || typeof cfg.skills.workshop.autonomous !== 'object') {
            cfg.skills.workshop.autonomous = {};
            changed = true;
        }
        if (cfg.skills.workshop.autonomous.enabled !== false) {
            cfg.skills.workshop.autonomous.enabled = false;
            changed = true;
        }
        if (!cfg.skills.entries || typeof cfg.skills.entries !== 'object') {
            cfg.skills.entries = {};
            changed = true;
        }
        if (!cfg.tools || typeof cfg.tools !== 'object') { cfg.tools = {}; changed = true; }
        if (!Array.isArray(cfg.tools.alsoAllow)) {
            cfg.tools.alsoAllow = [];
            changed = true;
        }
        if (!cfg.tools.alsoAllow.includes('skill_workshop')) {
            cfg.tools.alsoAllow.push('skill_workshop');
            changed = true;
        }
        // agnes-ai / messaging 配置里也补上，避免 byProvider 挡掉
        try {
            if (!cfg.tools.byProvider) cfg.tools.byProvider = {};
            for (const key of Object.keys(cfg.tools.byProvider)) {
                const bp = cfg.tools.byProvider[key];
                if (!bp || typeof bp !== 'object') continue;
                if (!Array.isArray(bp.alsoAllow)) bp.alsoAllow = [];
                if (!bp.alsoAllow.includes('skill_workshop')) {
                    bp.alsoAllow.push('skill_workshop');
                    changed = true;
                }
            }
            if (!cfg.tools.byProvider['agnes-ai']) {
                // 不强制新建整段 profile，只在已有时补
            } else {
                const ag = cfg.tools.byProvider['agnes-ai'];
                if (!Array.isArray(ag.alsoAllow)) ag.alsoAllow = [];
                if (!ag.alsoAllow.includes('skill_workshop')) {
                    ag.alsoAllow.push('skill_workshop');
                    changed = true;
                }
            }
        } catch (e) {}
        return { config: cfg, changed };
    }

    function runCli(args, timeoutMs = 60000, options = {}) {
        return new Promise((resolve) => {
            const cli = resolveOpenClawCli();
            const node = resolveNode();
            if (!cli || !fs.existsSync(cli)) {
                resolve({ ok: false, error: 'openclaw CLI not found', stdout: '', stderr: '' });
                return;
            }
            const cwd = options.cwd || path.join(getConfigDir(), 'workspace');
            const child = spawn(node || 'node', [cli, ...args], {
                cwd: fs.existsSync(cwd) ? cwd : getConfigDir(),
                env: {
                    ...process.env,
                    OPENCLAW_STATE_DIR: getConfigDir(),
                    OPENCLAW_HOME: path.dirname(getConfigDir())
                },
                windowsHide: true
            });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                try { child.kill(); } catch (e) {}
                resolve({ ok: false, error: 'timeout', stdout, stderr });
            }, timeoutMs);
            child.stdout.on('data', (d) => { stdout += String(d || ''); });
            child.stderr.on('data', (d) => { stderr += String(d || ''); });
            child.on('error', (err) => {
                clearTimeout(timer);
                resolve({ ok: false, error: err.message || String(err), stdout, stderr });
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                resolve({ ok: code === 0, code, stdout, stderr, error: code === 0 ? null : (stderr || stdout || `exit ${code}`) });
            });
        });
    }

    function listInstalledSkills() {
        const root = workspaceSkillsDir();
        const files = walkSkillMdFiles(root);
        const cfg = readOpenClawConfig();
        const entries = (cfg.skills && cfg.skills.entries) || {};
        const byName = new Map();
        for (const file of files) {
            let raw = '';
            try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
            const { meta } = parseFrontmatter(raw);
            const dirName = path.basename(path.dirname(file));
            const name = String(meta.name || dirName).trim() || dirName;
            const rel = path.relative(root, path.dirname(file)).replace(/\\/g, '/');
            const entry = entries[name] || entries[dirName] || {};
            const enabled = entry.enabled !== false;
            const item = {
                id: name,
                name,
                description: String(meta.description || '').trim(),
                path: path.dirname(file),
                relativePath: rel,
                skillFile: file,
                protected: PROTECTED_SKILLS.has(name) || PROTECTED_SKILLS.has(dirName),
                enabled,
                source: 'workspace'
            };
            if (!byName.has(name) || rel.split('/').length < String(byName.get(name).relativePath || '').split('/').length) {
                byName.set(name, item);
            }
        }
        return Array.from(byName.values())
            .filter((s) => hasMeaningfulDescription(s.description))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    function readSkill(name) {
        const skills = listInstalledSkills();
        const hit = skills.find((s) => s.name === name || s.id === name);
        if (!hit) return { success: false, error: 'skill not found' };
        const raw = fs.readFileSync(hit.skillFile, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        return {
            success: true,
            skill: {
                ...hit,
                frontmatter: meta,
                body,
                content: raw
            }
        };
    }

    function setSkillEnabled(name, enabled) {
        const key = String(name || '').trim();
        if (!key) return { success: false, error: 'missing name' };
        const cfg = readOpenClawConfig();
        if (!cfg.skills) cfg.skills = {};
        if (!cfg.skills.entries) cfg.skills.entries = {};
        if (!cfg.skills.entries[key]) cfg.skills.entries[key] = {};
        cfg.skills.entries[key].enabled = !!enabled;
        writeOpenClawConfig(cfg);
        return { success: true, name: key, enabled: !!enabled };
    }

    function deleteSkill(name) {
        const key = String(name || '').trim();
        if (!key) return { success: false, error: 'missing name' };
        if (PROTECTED_SKILLS.has(key)) {
            return { success: false, error: '内置媒体技能不可删除' };
        }
        const skills = listInstalledSkills();
        const hit = skills.find((s) => s.name === key || s.id === key);
        if (!hit) return { success: false, error: 'skill not found' };
        if (hit.protected) return { success: false, error: '内置媒体技能不可删除' };
        fs.rmSync(hit.path, { recursive: true, force: true });
        try {
            const cfg = readOpenClawConfig();
            if (cfg.skills && cfg.skills.entries && cfg.skills.entries[key]) {
                delete cfg.skills.entries[key];
                writeOpenClawConfig(cfg);
            }
        } catch (e) {}
        return { success: true, name: key };
    }

    function listProposalsFromFs(statusFilter) {
        const root = workshopRoot();
        const index = readJsonSafe(path.join(root, 'proposals.json'), null);
        const items = [];
        const dir = path.join(root, 'proposals');
        let ids = [];
        if (index && Array.isArray(index.proposals)) {
            ids = index.proposals.map((p) => p && (p.id || p.proposalId)).filter(Boolean);
        } else if (fs.existsSync(dir)) {
            try { ids = fs.readdirSync(dir); } catch (e) { ids = []; }
        }
        const seen = new Set();
        for (const id of ids) {
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const pDir = path.join(dir, id);
            const metaPath = path.join(pDir, 'proposal.json');
            if (!fs.existsSync(metaPath)) continue;
            const meta = readJsonSafe(metaPath, null);
            if (!meta) continue;
            const status = String(meta.status || 'pending').toLowerCase();
            if (statusFilter && status !== String(statusFilter).toLowerCase()) continue;
            let preview = '';
            try {
                const md = path.join(pDir, 'PROPOSAL.md');
                if (fs.existsSync(md)) preview = fs.readFileSync(md, 'utf8');
            } catch (e) {}
            const fm = parseFrontmatter(preview);
            const description = String(meta.description || fm.meta.description || '').trim();
            const skillName = String(meta.name || meta.skillName || fm.meta.name || '').trim() || id;
            const bodyText = String(fm.body || '')
                .replace(/^#+\s*.*$/m, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 160);
            items.push({
                id: meta.id || id,
                name: skillName,
                description,
                status,
                createdAt: meta.createdAt || meta.date || null,
                updatedAt: meta.updatedAt || null,
                scan: meta.scan || meta.scanner || null,
                goal: meta.goal || '',
                preview: bodyText,
                path: pDir
            });
        }
        items.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        return items.filter((it) => hasMeaningfulDescription(it.description || it.preview));
    }

    function inspectProposalFromFs(proposalId) {
        const id = String(proposalId || '').trim();
        if (!id) return { success: false, error: 'missing proposalId' };
        const pDir = path.join(workshopRoot(), 'proposals', id);
        const meta = readJsonSafe(path.join(pDir, 'proposal.json'), null);
        if (!meta) return { success: false, error: 'proposal not found' };
        let content = '';
        try {
            const md = path.join(pDir, 'PROPOSAL.md');
            if (fs.existsSync(md)) content = fs.readFileSync(md, 'utf8');
        } catch (e) {}
        return {
            success: true,
            proposal: {
                ...meta,
                id: meta.id || id,
                content,
                path: pDir
            }
        };
    }

    function applyProposalFromFs(proposalId) {
        const inspected = inspectProposalFromFs(proposalId);
        if (!inspected.success) return inspected;
        const proposal = inspected.proposal;
        const status = String(proposal.status || 'pending').toLowerCase();
        if (status !== 'pending' && status !== 'quarantined') {
            return { success: false, error: `提案状态为 ${status}，无法启用` };
        }
        const { meta } = parseFrontmatter(proposal.content || '');
        const name = String(proposal.name || meta.name || '').trim();
        if (!name) return { success: false, error: '提案缺少技能名' };
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
            return { success: false, error: '技能名不合法（小写字母/数字/中划线/下划线）' };
        }
        const dest = path.join(workspaceSkillsDir(), name);
        fs.mkdirSync(dest, { recursive: true });
        const skillMd = stripProposalOnlyFrontmatter(proposal.content || buildSkillMd({
            name,
            description: proposal.description || name,
            body: ''
        }));
        fs.writeFileSync(path.join(dest, 'SKILL.md'), skillMd, 'utf8');

        // 拷贝标准支持目录
        for (const sub of ['assets', 'examples', 'references', 'scripts', 'templates']) {
            const srcSub = path.join(proposal.path, sub);
            if (!fs.existsSync(srcSub)) continue;
            try {
                fs.cpSync(srcSub, path.join(dest, sub), { recursive: true, force: true });
            } catch (e) {}
        }

        proposal.status = 'applied';
        proposal.appliedAt = new Date().toISOString();
        writeJsonSafe(path.join(proposal.path, 'proposal.json'), proposal);

        // 索引同步（尽力）
        try {
            const indexPath = path.join(workshopRoot(), 'proposals.json');
            const index = readJsonSafe(indexPath, { proposals: [] });
            if (!Array.isArray(index.proposals)) index.proposals = [];
            const hit = index.proposals.find((p) => (p.id || p.proposalId) === proposalId);
            if (hit) hit.status = 'applied';
            writeJsonSafe(indexPath, index);
        } catch (e) {}

        setSkillEnabled(name, true);
        return { success: true, name, path: dest };
    }

    function rejectProposalFromFs(proposalId, reason, quarantined) {
        const inspected = inspectProposalFromFs(proposalId);
        if (!inspected.success) return inspected;
        const proposal = inspected.proposal;
        proposal.status = quarantined ? 'quarantined' : 'rejected';
        proposal.reason = String(reason || '').trim() || (quarantined ? 'quarantined by operator' : 'rejected by operator');
        proposal.closedAt = new Date().toISOString();
        writeJsonSafe(path.join(proposal.path, 'proposal.json'), proposal);
        try {
            const indexPath = path.join(workshopRoot(), 'proposals.json');
            const index = readJsonSafe(indexPath, { proposals: [] });
            if (Array.isArray(index.proposals)) {
                const hit = index.proposals.find((p) => (p.id || p.proposalId) === proposalId);
                if (hit) hit.status = proposal.status;
                writeJsonSafe(indexPath, index);
            }
        } catch (e) {}
        return { success: true, id: proposalId, status: proposal.status };
    }

    function createDraftProposal({ name, description, body }) {
        const skillName = String(name || '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skillName)) {
            return { success: false, error: '技能名不合法：小写字母、数字、中划线、下划线' };
        }
        if (PROTECTED_SKILLS.has(skillName)) {
            return { success: false, error: '不能覆盖内置媒体技能名' };
        }
        const existing = listInstalledSkills().find((s) => s.name === skillName);
        if (existing) {
            return { success: false, error: `技能 ${skillName} 已存在，请先删除或用对话发起 update 提案` };
        }
        const desc = String(description || '').trim() || skillName;
        const content = buildSkillMd({
            name: skillName,
            description: desc,
            body: body || `# ${skillName}\n\n当用户需要此能力时，按下列步骤执行。\n`
        });
        // 提案 frontmatter 加 status
        const proposalContent = content.replace(
            /^---\n/,
            `---\nstatus: proposal\nversion: "v1"\ndate: ${JSON.stringify(new Date().toISOString())}\n`
        );

        const id = `nexora-${skillName}-${Date.now().toString(36)}`;
        const pDir = path.join(workshopRoot(), 'proposals', id);
        fs.mkdirSync(pDir, { recursive: true });
        fs.writeFileSync(path.join(pDir, 'PROPOSAL.md'), proposalContent, 'utf8');
        const meta = {
            id,
            name: skillName,
            description: desc,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdBy: 'nexora-ui',
            source: 'manual'
        };
        writeJsonSafe(path.join(pDir, 'proposal.json'), meta);

        const indexPath = path.join(workshopRoot(), 'proposals.json');
        const index = readJsonSafe(indexPath, { proposals: [] });
        if (!Array.isArray(index.proposals)) index.proposals = [];
        index.proposals.unshift({
            id,
            name: skillName,
            description: desc,
            status: 'pending',
            createdAt: meta.createdAt
        });
        writeJsonSafe(indexPath, index);

        // 尽力走官方 CLI（失败也不影响本地提案）
        Promise.resolve().then(async () => {
            try {
                const tmp = path.join(os.tmpdir(), `nexora-skill-${id}.md`);
                fs.writeFileSync(tmp, proposalContent, 'utf8');
                await runCli([
                    'skills', 'workshop', 'propose-create',
                    '--name', skillName,
                    '--description', desc,
                    '--proposal', tmp,
                    '--json'
                ], 45000);
                try { fs.unlinkSync(tmp); } catch (e) {}
            } catch (e) {}
        });

        return { success: true, proposalId: id, name: skillName };
    }

    async function applyProposal(proposalId) {
        const cli = await runCli(['skills', 'workshop', 'apply', String(proposalId), '--json'], 90000);
        if (cli.ok) {
            try {
                const parsed = JSON.parse(cli.stdout || '{}');
                return { success: true, via: 'cli', result: parsed };
            } catch (e) {
                return { success: true, via: 'cli', stdout: cli.stdout };
            }
        }
        return applyProposalFromFs(proposalId);
    }

    async function rejectProposal(proposalId, reason) {
        const cli = await runCli([
            'skills', 'workshop', 'reject', String(proposalId),
            '--reason', String(reason || 'rejected by operator'),
            '--json'
        ], 60000);
        if (cli.ok) return { success: true, via: 'cli' };
        return rejectProposalFromFs(proposalId, reason, false);
    }

    async function quarantineProposal(proposalId, reason) {
        const cli = await runCli([
            'skills', 'workshop', 'quarantine', String(proposalId),
            '--reason', String(reason || 'quarantined by operator'),
            '--json'
        ], 60000);
        if (cli.ok) return { success: true, via: 'cli' };
        return rejectProposalFromFs(proposalId, reason, true);
    }

    function ensureSkillWorkshopGuidance(wsDir) {
        try {
            const agentsPath = path.join(wsDir, 'AGENTS.md');
            if (!fs.existsSync(agentsPath)) return false;
            let cur = fs.readFileSync(agentsPath, 'utf8');
            if (cur.includes(SKILL_WORKSHOP_GUIDANCE_MARKER)) return false;
            const section = [
                '',
                '## 技能创建与审核',
                SKILL_WORKSHOP_GUIDANCE_MARKER,
                '- 用户要求「做一个技能 / 学会这个流程 / 下次按这个做」时：用 `skill_workshop` 创建或修订**提案**（pending），不要直接 `write`/`edit` live `SKILL.md`。',
                '- **不要**自行 `apply` / `reject` / `quarantine`；主人在 Nexora「技能中心」审核通过后才会启用。',
                '- 微信与本机对话均可发起；创建后告知用户去「技能中心 → 待审核」查看。',
                ''
            ].join('\n');
            fs.appendFileSync(agentsPath, section, 'utf8');
            return true;
        } catch (e) {
            return false;
        }
    }

    function openSkillFolder(name) {
        const hit = listInstalledSkills().find((s) => s.name === name || s.id === name);
        if (!hit) return { success: false, error: 'skill not found' };
        return { success: true, path: hit.path };
    }

    function httpGetJson(url, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (err, val) => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve(val);
            };

            // Electron net.fetch 更吃系统代理，失败再回退 https
            try {
                const { net } = require('electron');
                if (net && typeof net.fetch === 'function') {
                    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
                    net.fetch(url, {
                        headers: {
                            Accept: 'application/json',
                            'User-Agent': 'NexoraAgent/1.0'
                        }
                    }).then(async (res) => {
                        clearTimeout(timer);
                        const data = await res.text();
                        finish(null, { status: res.status || 0, data: data || '' });
                    }).catch((e) => {
                        clearTimeout(timer);
                        finish(e);
                    });
                    return;
                }
            } catch (e) {}

            const https = require('https');
            const req = https.get(url, {
                timeout: timeoutMs,
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'NexoraAgent/1.0'
                }
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => finish(null, { status: res.statusCode || 0, data }));
            });
            req.on('error', (e) => finish(e));
            req.on('timeout', () => {
                try { req.destroy(); } catch (e) {}
                finish(new Error('timeout'));
            });
        });
    }

    function mapClawHubSkillEntry(r) {
        let slug = String(r.slug || r.name || '').trim();
        // API / 旧链接偶发带 skills/ 前缀，去掉以免拼出 /skills/skills/xxx
        if (slug.toLowerCase().startsWith('skills/')) slug = slug.slice(7);
        const owner = String(r.ownerHandle || (r.owner && r.owner.handle) || '').trim();
        const ref = owner ? `@${owner}/${slug}` : slug;
        const stats = r.stats || {};
        const version = r.version
            || (r.latestVersion && (r.latestVersion.version || r.latestVersion))
            || (r.tags && r.tags.latest)
            || null;
        const summary = String(r.summary || '').trim();
        const description = String(r.description || '').trim();
        // 正确页面格式：https://clawhub.ai/{owner}/skills/{slug}
        // 无 owner 时不要拼 /skills/{slug}（站点会 307 到错误的 /skills/skills/...）
        const url = owner && slug
            ? `https://clawhub.ai/${encodeURIComponent(owner)}/skills/${encodeURIComponent(slug)}`
            : '';
        return {
            slug,
            ownerHandle: owner,
            ref,
            displayName: r.displayName || slug,
            icon: r.icon || r.emoji || r.logo || r.iconUrl || (r.meta && r.meta.icon) || '',
            summary: summary || description.slice(0, 180),
            description: description || summary,
            version: version ? String(version) : null,
            downloads: Number(stats.downloads || r.downloads || 0) || 0,
            stars: Number(stats.stars || 0) || 0,
            score: Number(r.score || 0) || 0,
            url
        };
    }

    async function fetchPopularClawHubSkills(limit = 24) {
        const lim = Math.min(50, Math.max(1, Number(limit) || 24));
        const urls = [
            `https://clawhub.ai/api/v1/skills?sort=downloads&limit=${lim}`,
            `https://clawhub.ai/api/v1/skills?sort=installs&limit=${lim}`,
            `https://clawhub.ai/api/v1/skills?sort=stars&limit=${lim}`
        ];
        let lastErr = null;
        for (const url of urls) {
            try {
                const body = await httpGetJson(url);
                if (body.status < 200 || body.status >= 300) {
                    lastErr = new Error(`ClawHub HTTP ${body.status}`);
                    continue;
                }
                const parsed = JSON.parse(body.data || '{}');
                const items = Array.isArray(parsed.items)
                    ? parsed.items
                    : (Array.isArray(parsed.results) ? parsed.results : []);
                const mapped = items.map(mapClawHubSkillEntry).filter((x) => x.slug && x.summary.length >= 8);
                if (mapped.length) return mapped;
            } catch (e) {
                lastErr = e;
            }
        }
        // 再兜底：用几个热门关键词搜索合并
        const seeds = ['agent', 'github', 'memory', 'search', 'skill'];
        const merged = new Map();
        for (const seed of seeds) {
            try {
                const body = await httpGetJson(`https://clawhub.ai/api/v1/search?q=${encodeURIComponent(seed)}&limit=8`);
                if (body.status < 200 || body.status >= 300) continue;
                const parsed = JSON.parse(body.data || '{}');
                const results = Array.isArray(parsed.results) ? parsed.results : [];
                for (const r of results.map(mapClawHubSkillEntry)) {
                    if (!r.slug || r.summary.length < 8) continue;
                    if (!merged.has(r.slug)) merged.set(r.slug, r);
                }
                if (merged.size >= lim) break;
            } catch (e) {
                lastErr = e;
            }
        }
        if (merged.size) {
            return Array.from(merged.values())
                .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
                .slice(0, lim);
        }
        throw lastErr || new Error('popular fetch failed');
    }

    async function searchClawHub(query, limit = 24) {
        const rawQ = String(query || '').trim();
        const lim = Math.min(50, Math.max(1, Number(limit) || 24));
        // 无查询词 / 通配：展示下载量热门推荐
        if (!rawQ || rawQ === '*' || rawQ === 'hot' || rawQ === 'popular') {
            try {
                const results = await fetchPopularClawHubSkills(lim);
                console.log(`[SkillCenter] ClawHub popular loaded: ${results.length}`);
                return { success: true, mode: 'popular', results };
            } catch (e) {
                console.warn('[SkillCenter] ClawHub popular failed:', e.message || e);
                return { success: false, mode: 'popular', error: e.message || 'popular fetch failed', results: [] };
            }
        }

        const url = `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(rawQ)}&limit=${lim}`;
        try {
            const body = await httpGetJson(url);
            if (body.status < 200 || body.status >= 300) {
                return { success: false, mode: 'search', error: `ClawHub HTTP ${body.status}`, results: [] };
            }
            const parsed = JSON.parse(body.data || '{}');
            let results = (Array.isArray(parsed.results) ? parsed.results : [])
                .map(mapClawHubSkillEntry)
                .filter((x) => x.slug && x.summary.length >= 8);
            // 搜索无结果时回退热门，避免空白
            if (!results.length) {
                try {
                    const popular = await fetchPopularClawHubSkills(lim);
                    return { success: true, mode: 'popular', results: popular, note: 'search_empty_fallback_popular' };
                } catch (e2) {}
            }
            return { success: true, mode: 'search', results };
        } catch (e) {
            try {
                const popular = await fetchPopularClawHubSkills(lim);
                return { success: true, mode: 'popular', results: popular, note: 'search_error_fallback_popular', error: e.message };
            } catch (e2) {
                return { success: false, mode: 'search', error: e.message || 'search failed', results: [] };
            }
        }
    }

    async function installFromClawHub(skillRef, opts = {}) {
        const ref = String(skillRef || '').trim();
        if (!ref) return { success: false, error: 'missing skill ref' };
        const args = [
            'skills', 'install', ref,
            '--acknowledge-clawhub-risk'
        ];
        if (opts.force) args.push('--force');
        if (opts.version) {
            args.push('--version', String(opts.version));
        }
        // 装到当前 workspace（OPENCLAW_STATE_DIR/workspace）
        const cli = await runCli(args, 180000);
        if (!cli.ok) {
            return {
                success: false,
                error: cli.error || cli.stderr || cli.stdout || 'install failed'
            };
        }
        // 解析技能名并默认禁用（需用户在「已安装」显式启用）
        let skillName = ref.includes('/') ? ref.split('/').pop() : ref.replace(/^@/, '');
        skillName = String(skillName || '').replace(/^@/, '').trim();
        // 装完后从磁盘再确认一次
        const installed = listInstalledSkills().find((s) =>
            s.name === skillName || s.relativePath === skillName || s.relativePath.endsWith('/' + skillName)
        );
        if (installed) skillName = installed.name;
        if (skillName) {
            setSkillEnabled(skillName, false);
        }
        return {
            success: true,
            name: skillName,
            stdout: cli.stdout,
            note: 'installed_disabled'
        };
    }

    return {
        PROTECTED_SKILLS,
        ensureWorkshopConfig,
        ensureSkillWorkshopGuidance,
        listInstalledSkills,
        readSkill,
        setSkillEnabled,
        deleteSkill,
        listProposalsFromFs,
        inspectProposalFromFs,
        createDraftProposal,
        applyProposal,
        rejectProposal,
        quarantineProposal,
        openSkillFolder,
        searchClawHub,
        installFromClawHub,
        workspaceSkillsDir,
        workshopRoot
    };
}

module.exports = {
    createSkillCenter,
    PROTECTED_SKILLS,
    SKILL_WORKSHOP_GUIDANCE_MARKER
};
