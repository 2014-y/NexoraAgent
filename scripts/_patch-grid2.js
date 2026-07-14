'use strict';
const fs = require('fs');
const p = 'C:/Users/Yuan/Desktop/ClawAI/ClawAI/renderer.js';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('// \u6e32\u67d3\u63d2\u4ef6\u5361\u7247\u7f51\u683c');
const end = s.indexOf('// \u8fdb\u5ea6\u66f4\u65b0\u4e2d\u5fc3\u9a71\u52a8');
if (start < 0 || end < 0) {
  console.error('markers not found', start, end);
  process.exit(1);
}

const neu = fs.readFileSync('C:/Users/Yuan/Desktop/ClawAI/ClawAI/scripts/_render-plugins-grid.jsfragment', 'utf8');
fs.writeFileSync(p, s.slice(0, start) + neu + s.slice(end));
console.log('patched ok', neu.length);
