const fs = require('fs');
const path = require('path');

const nvmRoot = path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'nvm');
if (!fs.existsSync(nvmRoot)) {
  console.log('  NVM not found, skipping warning fixes');
  process.exit(0);
}

const dirs = fs.readdirSync(nvmRoot).filter(d => /^v\d/.test(d)).sort().reverse();
let found = false;

// Patterns to suppress in OpenClaw source files
const warningPatterns = [
  /"⚠️ Media failed\."/g,
  /"Media failed"/g,
  /console\.warn\(.*Media.*\)/g,
  /console\.error\(.*Media.*\)/g,
];

for (const ver of dirs) {
  const distPath = path.join(nvmRoot, ver, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distPath)) continue;
  
  const files = fs.readdirSync(distPath).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
  for (const f of files) {
    const filePath = path.join(distPath, f);
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      let modified = false;
      
      for (const pattern of warningPatterns) {
        if (pattern.test(content)) {
          content = content.replace(pattern, '');
          modified = true;
        }
      }
      
      if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('  Fixed: ' + filePath);
        found = true;
      }
    } catch (e) {
      // skip binary or unreadable files
    }
  }
  if (found) break;
}

if (!found) {
  console.log('  No warnings found (already fixed or not needed)');
}