'use strict';
/**
 * 每次打包前清理旧的安装包/构建产物，保证 dist 里只留本次新打的包。
 * - 清理 dist / dist-new / dist_release / dist2，禁止新旧产物混装
 * - Windows 临时文件锁导致删除失败时，把旧目录原子移入隔离区再继续
 * - 删除和隔离都失败才终止构建，绝不在旧输出目录上覆盖
 * 由 preapp:dist 在打包前自动调用。
 */
const fs = require('fs');
const path = require('path');
const {
  DEFAULT,
  FALLBACK,
  writeBuildOutputDir
} = require('./build-output-dir');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIRS = ['dist', 'dist-new', 'dist_release', 'dist2'];
const QUARANTINE_ROOT = path.join(ROOT, 'build-resources', '_stale-output');

function rmrf(target) {
  try {
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250
    });
    return { ok: !fs.existsSync(target), error: null };
  } catch (error) {
    // Windows 上 fs.rmSync 可能在最后一步完成后仍回报瞬时错误。
    return { ok: !fs.existsSync(target), error };
  }
}

function quarantine(target, name) {
  fs.mkdirSync(QUARANTINE_ROOT, { recursive: true });
  const dest = path.join(
    QUARANTINE_ROOT,
    `${name}-${Date.now()}-${process.pid}`
  );
  fs.renameSync(target, dest);
  // 隔离后再尽力删除；仍被 Defender/索引器占用也不影响本轮全新构建。
  const removed = rmrf(dest);
  return { dest, removed: removed.ok };
}

function cleanOutputDir(name) {
  const full = path.join(ROOT, name);
  if (!fs.existsSync(full)) return { name, status: 'missing' };

  const result = rmrf(full);
  if (result.ok) {
    console.log('[clean-dist] removed ' + name + '/');
    return { name, status: 'removed' };
  }

  try {
    const moved = quarantine(full, name);
    console.warn(
      `[clean-dist] ${name}/ was locked; moved stale output to ${moved.dest}`
      + (moved.removed ? ' and removed it' : ' (background lock may keep it temporarily)')
    );
    return { name, status: 'quarantined' };
  } catch (renameError) {
    const removeMessage = result.error && (result.error.code || result.error.message);
    const renameMessage = renameError && (renameError.code || renameError.message);
    console.error(`[clean-dist] ${name}/ cleanup failed: remove=${removeMessage}; quarantine=${renameMessage}`);
    return { name, status: 'failed', error: renameMessage || removeMessage };
  }
}

const results = OUT_DIRS.map(cleanOutputDir);
const cleaned = results.filter((item) => item.status === 'removed').length;
const quarantined = results.filter((item) => item.status === 'quarantined').length;
const failedNames = results.filter((item) => item.status === 'failed').map((item) => item.name);

if (!cleaned && !quarantined && !failedNames.length) {
  console.log('[clean-dist] nothing to clean');
}

if (failedNames.includes(DEFAULT)) {
  const fallbackResult = cleanOutputDir(FALLBACK);
  if (fallbackResult.status === 'failed') {
    throw new Error(
      `[clean-dist] both ${DEFAULT}/ and ${FALLBACK}/ are locked; close the process holding them and retry`
    );
  }
  writeBuildOutputDir(FALLBACK);
  console.warn(`[clean-dist] ${DEFAULT}/ is locked; this build will output to ${FALLBACK}/`);
} else if (failedNames.length) {
  throw new Error(
    `[clean-dist] refusing to build on top of stale output (${failedNames.join(', ')}); close locks and retry`
  );
} else {
  writeBuildOutputDir(DEFAULT);
}
