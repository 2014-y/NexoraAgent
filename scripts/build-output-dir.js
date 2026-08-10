'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MARKER = path.join(ROOT, '.build-output-dir');
const DEFAULT = 'dist';
const FALLBACK = 'dist-release';

function writeBuildOutputDir(name) {
  fs.writeFileSync(MARKER, String(name || DEFAULT).trim(), 'utf8');
}

function getBuildOutputDir() {
  if (process.env.BUILD_OUTPUT_DIR) {
    return String(process.env.BUILD_OUTPUT_DIR).trim();
  }
  try {
    if (fs.existsSync(MARKER)) {
      const value = fs.readFileSync(MARKER, 'utf8').trim();
      if (value) return value;
    }
  } catch (e) {}
  return DEFAULT;
}

function resolveBuildOutputPath(...segments) {
  return path.join(ROOT, getBuildOutputDir(), ...segments);
}

module.exports = {
  ROOT,
  MARKER,
  DEFAULT,
  FALLBACK,
  writeBuildOutputDir,
  getBuildOutputDir,
  resolveBuildOutputPath
};
