// Diagnose plugin loading issues
const fs = require('fs');
const path = require('path');

const configDir = path.join(process.env.USERPROFILE || '', '.openclaw');
const configPath = path.join(configDir, 'openclaw.json');

console.log('=== CONFIG_DIR:', configDir);
console.log('=== CONFIG_PATH:', configPath);
console.log('=== EXISTS:', fs.existsSync(configPath));

if (!fs.existsSync(configPath)) {
    console.log('CONFIG NOT FOUND!');
    process.exit(1);
}

const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
const config = JSON.parse(raw);

// 1. Check plugins.entries - which are enabled
console.log('\n=== PLUGIN ENTRIES (enabled status) ===');
const entries = config.plugins && config.plugins.entries || {};
for (const [id, entry] of Object.entries(entries)) {
    console.log(`  ${id}: enabled=${entry.enabled}`);
}

// 2. Check plugins.allow
console.log('\n=== ALLOW LIST ===');
const allow = config.plugins && config.plugins.allow || [];
console.log('  ' + allow.join(', '));

// 3. Check plugins.load.paths and their existence
console.log('\n=== LOAD.PATHS (with existence check) ===');
const loadPaths = config.plugins && config.plugins.load && config.plugins.load.paths || [];
for (const p of loadPaths) {
    const exists = fs.existsSync(p);
    const hasPkg = exists && fs.existsSync(path.join(p, 'package.json'));
    console.log(`  ${exists ? '✓' : '✗'} ${hasPkg ? '[pkg.json]' : '[NO pkg]'} ${p}`);
    if (hasPkg) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'));
            const exts = pkg.openclaw && pkg.openclaw.extensions;
            console.log(`    name: ${pkg.name}, type: ${pkg.type || 'cjs'}, extensions: ${JSON.stringify(exts)}`);
            // Check if extensions files exist
            if (exts && Array.isArray(exts)) {
                for (const ext of exts) {
                    const extPath = path.isAbsolute(ext) ? ext : path.join(p, ext);
                    console.log(`    ext ${ext} exists: ${fs.existsSync(extPath)}`);
                }
            }
        } catch (e) {
            console.log(`    parse error: ${e.message}`);
        }
    }
}

// 4. Check plugins.installs
console.log('\n=== INSTALLS ===');
const installs = config.plugins && config.plugins.installs || {};
for (const [id, install] of Object.entries(installs)) {
    const exists = install.installPath ? fs.existsSync(install.installPath) : false;
    console.log(`  ${id}: ${exists ? '✓' : '✗'} ${install.installPath || '(no path)'}`);
}

// 5. Check extensions directory
console.log('\n=== EXTENSIONS DIRECTORY ===');
const extDir = path.join(configDir, 'extensions');
if (fs.existsSync(extDir)) {
    const items = fs.readdirSync(extDir);
    for (const item of items) {
        const fullPath = path.join(extDir, item);
        const isDir = fs.statSync(fullPath).isDirectory();
        if (isDir) {
            const hasPkg = fs.existsSync(path.join(fullPath, 'package.json'));
            const hasIndex = fs.existsSync(path.join(fullPath, 'index.js'));
            console.log(`  ${item}: pkg.json=${hasPkg}, index.js=${hasIndex}`);
            if (hasPkg) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(path.join(fullPath, 'package.json'), 'utf8'));
                    console.log(`    type: ${pkg.type || 'cjs'}, openclaw.extensions: ${JSON.stringify(pkg.openclaw && pkg.openclaw.extensions)}`);
                } catch (e) {}
            }
        }
    }
} else {
    console.log('  (directory not found)');
}

// 6. Check bundled plugins in node_modules
console.log('\n=== BUNDLED PLUGINS IN NODE_MODULES ===');
const appRoot = path.resolve(__dirname, '..');
const checkBundled = [
    ['@tencent-weixin/openclaw-weixin', path.join(appRoot, 'node_modules', '@tencent-weixin', 'openclaw-weixin')],
    ['@openclaw/feishu', path.join(appRoot, 'node_modules', '@openclaw', 'feishu')],
    ['@openclaw/qqbot', path.join(appRoot, 'node_modules', '@openclaw', 'qqbot')],
    ['@openclaw/feishu (ProgramFiles)', path.join('C:\\Program Files\\Nexora Agent\\resources\\app\\node_modules\\@openclaw\\feishu')],
    ['@openclaw/qqbot (ProgramFiles)', path.join('C:\\Program Files\\Nexora Agent\\resources\\app\\node_modules\\@openclaw\\qqbot')],
];
for (const [name, p] of checkBundled) {
    const exists = fs.existsSync(p);
    console.log(`  ${exists ? '✓' : '✗'} ${name} → ${p}`);
}

// 7. Check channels config
console.log('\n=== CHANNELS CONFIG ===');
if (config.channels) {
    for (const [id, ch] of Object.entries(config.channels)) {
        if (typeof ch === 'object') {
            console.log(`  ${id}: enabled=${ch.enabled}, hasAccounts=${!!(ch.accounts && Object.keys(ch.accounts).length)}`);
        }
    }
} else {
    console.log('  (no channels section)');
}

// 8. Check gateway.auth
console.log('\n=== GATEWAY AUTH ===');
if (config.gateway && config.gateway.auth) {
    console.log(`  mode: ${config.gateway.auth.mode}`);
    console.log(`  token: ${config.gateway.auth.token ? config.gateway.auth.token.slice(0, 10) + '...' : '(empty!)'}`);
} else {
    console.log('  (no gateway.auth section!)');
}
