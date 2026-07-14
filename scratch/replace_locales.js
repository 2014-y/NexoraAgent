const fs = require('fs');
const path = require('path');

const localesPath = path.join(__dirname, '..', 'locales.js');
let content = fs.readFileSync(localesPath, 'utf8');

// 正则匹配 locales 字典行: 'key': 'value',
// 第1组是键和冒号及空格，第2组是引号，第3组是值
content = content.replace(/(['"].*?['"]\s*:\s*)(['"])(.*?)\2/g, (match, p1, p2, p3) => {
    let newValue = p3;
    // 替换 简体中文“网关”、繁体中文“網關”、英文“Gateway”
    newValue = newValue.replace(/网关/g, 'ClawAI');
    newValue = newValue.replace(/網關/g, 'ClawAI');
    newValue = newValue.replace(/Gateway/g, 'ClawAI');
    return p1 + p2 + newValue + p2;
});

fs.writeFileSync(localesPath, content, 'utf8');
console.log('locales.js text replaced successfully!');
