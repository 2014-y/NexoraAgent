const fs = require('fs');
const path = require('path');

// 1. 处理 renderer.js
const rendererPath = path.join(__dirname, '..', 'renderer.js');
if (fs.existsSync(rendererPath)) {
    let rendererContent = fs.readFileSync(rendererPath, 'utf8');
    rendererContent = rendererContent.replace(/网关/g, 'Nexora Agent');
    rendererContent = rendererContent.replace(/網關/g, 'Nexora Agent');
    fs.writeFileSync(rendererPath, rendererContent, 'utf8');
    console.log('renderer.js Chinese text replaced successfully!');
}

// 2. 处理 main.js
const mainPath = path.join(__dirname, '..', 'main.js');
if (fs.existsSync(mainPath)) {
    let mainContent = fs.readFileSync(mainPath, 'utf8');
    mainContent = mainContent.replace(/网关/g, 'Nexora Agent');
    mainContent = mainContent.replace(/網關/g, 'Nexora Agent');
    fs.writeFileSync(mainPath, mainContent, 'utf8');
    console.log('main.js Chinese text replaced successfully!');
}
