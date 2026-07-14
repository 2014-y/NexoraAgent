const fs = require('fs');
const path = require('path');

const localesPath = path.join(__dirname, '..', 'locales.js');
const lines = fs.readFileSync(localesPath, 'utf8').split('\n');

lines.forEach((line, index) => {
    if (line.includes('app_uptime')) {
        console.log(`Line ${index + 1}: ${line}`);
    }
});
