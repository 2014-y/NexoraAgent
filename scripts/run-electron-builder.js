'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { ROOT, getBuildOutputDir } = require('./build-output-dir');

const outputDir = getBuildOutputDir();
const args = process.argv.slice(2);
const builderCli = require.resolve('electron-builder/cli.js');
const builderArgs = [
  ...args,
  `--config.directories.output=${outputDir}`
];

console.log(`[run-electron-builder] output=${outputDir}`);

const result = spawnSync(
  process.execPath,
  [builderCli, ...builderArgs],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      BUILD_OUTPUT_DIR: outputDir
    }
  }
);

if (result.error) {
  console.error(`[run-electron-builder] failed to start: ${result.error.message}`);
  process.exit(1);
}
if (!Number.isInteger(result.status)) {
  console.error(`[run-electron-builder] terminated without an exit status${result.signal ? ` (signal=${result.signal})` : ''}`);
  process.exit(1);
}
process.exit(result.status);
