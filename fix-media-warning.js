const fs = require('fs');
const path = require('path');

const nvmRoot = path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'nvm');
if (!fs.existsSync(nvmRoot)) {
  console.log('  NVM not found, skipping media warning fix');
  process.exit(0);
}

const dirs = fs.readdirSync(nvmRoot).filter(d => /^v\d/.test(d)).sort().reverse();
let found = false;

for (const ver of dirs) {
  const modsPath = path.join(nvmRoot, ver, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(modsPath)) continue;
  
  const files = fs.readdirSync(modsPath).filter(f => f.startsWith('reply-payload-') && f.endsWith('.js'));
  for (const f of files) {
    const filePath = path.join(modsPath, f);
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('Media failed')) {
        content = content.replace(/"⚠️ Media failed\."/g, '""');
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('  Fixed: ' + filePath);
        found = true;
      }
    } catch (e) {
      // ignore
    }
  }
  if (found) break;
}

if (!found) {
  console.log('  No Media failed warning found (already fixed or not needed)');
}
