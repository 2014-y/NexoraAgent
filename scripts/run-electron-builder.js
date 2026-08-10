'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { ROOT, getBuildOutputDir } = require('./build-output-dir');

const outputDir = getBuildOutputDir();
const args = process.argv.slice(2);
const builderArgs = [
  ...args,
  `--config.directories.output=${outputDir}`
];

console.log(`[run-electron-builder] output=${outputDir}`);

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', ...builderArgs],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      BUILD_OUTPUT_DIR: outputDir
    }
  }
);

process.exit(result.status || 0);
