const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'index.html');
let content = fs.readFileSync(htmlPath, 'utf8');

// 1. 替换 data-question="网关启动报错..."
content = content.replace(/data-question="网关启动报错/g, 'data-question="ClawAI启动报错');
content = content.replace(/data-question="網關啟動報錯/g, 'data-question="ClawAI啟動報錯');

// 2. 替换特定的文字内容：
content = content.replace(/启动网关/g, '启动 ClawAI');
content = content.replace(/啟動網關/g, '啟動 ClawAI');
content = content.replace(/启用网关/g, '启用 ClawAI');
content = content.replace(/啟用網關/g, '啟用 ClawAI');
content = content.replace(/网关排查/g, 'ClawAI排查');
content = content.replace(/網關排查/g, 'ClawAI排查');

content = content.replace(/OpenClaw 网关处于断开/g, 'OpenClaw 处于断开');
content = content.replace(/OpenClaw 網關處於斷開/g, 'OpenClaw 處於斷開');

content = content.replace(/欢迎使用 AI 网关/g, '欢迎使用 ClawAI');
content = content.replace(/歡迎使用 AI 網關/g, '歡迎使用 ClawAI');

fs.writeFileSync(htmlPath, content, 'utf8');
console.log('index.html text replaced successfully!');
