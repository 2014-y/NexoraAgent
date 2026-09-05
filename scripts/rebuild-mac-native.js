'use strict';
const path = require('path');
const root = path.resolve(__dirname, '..');
const {rebuild} = require(require.resolve('@electron/rebuild', {paths: [path.dirname(require.resolve('electron-builder'))]}));
const electronVersion = require('../node_modules/electron/package.json').version;
rebuild({buildPath: root, electronVersion, arch: process.arch, onlyModules: ['node-pty'], force: true})
  .then(() => console.log(`[rebuild-mac-native] node-pty ready for Electron ${electronVersion}/${process.arch}`))
  .catch(error => { console.error(error); process.exitCode = 1; });
