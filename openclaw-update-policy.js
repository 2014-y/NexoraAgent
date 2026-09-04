'use strict';

const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/;

function normalizeVersion(value) {
    return String(value || '').trim().replace(/^v/i, '');
}

function isStableVersion(value) {
    return STABLE_VERSION_RE.test(normalizeVersion(value));
}

function parseStableVersion(value) {
    const normalized = normalizeVersion(value);
    if (!isStableVersion(normalized)) {
        throw new Error(`不是正式稳定版本号: ${String(value || '(empty)')}`);
    }
    const core = normalized.split('+', 1)[0].split('.').map((part) => Number(part));
    return { normalized, core };
}

function compareStableVersions(left, right) {
    const a = parseStableVersion(left).core;
    const b = parseStableVersion(right).core;
    for (let i = 0; i < 3; i += 1) {
        if (a[i] > b[i]) return 1;
        if (a[i] < b[i]) return -1;
    }
    return 0;
}

function resolveStableTarget(distTags, currentVersion, requestedVersion) {
    const tags = distTags && typeof distTags === 'object' ? distTags : {};
    const latest = normalizeVersion(tags.latest);
    if (!isStableVersion(latest)) {
        throw new Error(`npm latest 标签不是正式稳定版: ${latest || '(empty)'}`);
    }

    const current = normalizeVersion(currentVersion);
    const requested = normalizeVersion(requestedVersion);
    if (requested && !isStableVersion(requested)) {
        throw new Error(`拒绝安装预览版或非法版本: ${requested}`);
    }

    return {
        channel: 'latest',
        currentVersion: current,
        latestVersion: latest,
        requestedVersion: requested,
        requestedMatched: !requested || requested === latest,
        hasUpdate: !isStableVersion(current) || compareStableVersions(latest, current) > 0,
        aheadOfLatest: isStableVersion(current) && compareStableVersions(current, latest) > 0,
    };
}

function normalizeIntegrity(value) {
    const integrity = String(value || '').trim().replace(/^"|"$/g, '');
    if (!/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity)) {
        throw new Error('正式版缺少有效的 npm 完整性摘要');
    }
    return integrity;
}

function buildGatewayRuntimeManifest(appPackage, installedVersions = {}) {
    const source = appPackage && typeof appPackage === 'object' ? appPackage : {};
    const direct = {
        ...(source.dependencies || {}),
        ...(source.optionalDependencies || {}),
    };
    const dependencies = {};
    for (const [name, declared] of Object.entries(direct)) {
        const installed = normalizeVersion(installedVersions[name]);
        dependencies[name] = installed || String(declared || '').trim();
    }
    return {
        name: 'nexora-gateway-runtime',
        version: normalizeVersion(source.version) || '0.0.0',
        private: true,
        description: 'Mutable OpenClaw runtime managed by Nexora Agent',
        dependencies,
    };
}

module.exports = {
    OFFICIAL_NPM_REGISTRY,
    normalizeVersion,
    isStableVersion,
    parseStableVersion,
    compareStableVersions,
    resolveStableTarget,
    normalizeIntegrity,
    buildGatewayRuntimeManifest,
};
