// 引入 patch_gateway.js
require('C:/Users/Public/patch_gateway.js');

try {
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    const result = db.prepare('SELECT sqlite_version() AS version').get();
    console.log('Result:', result);
} catch (e) {
    console.error('Test error:', e);
}
