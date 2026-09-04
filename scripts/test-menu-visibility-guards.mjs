import assert from 'node:assert/strict';
import fs from 'node:fs';

const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8');

assert.match(renderer, /const SIDEBAR_NAV_FIXED_TAB = 'console-view'/, 'dashboard must be the fixed first menu');
assert.match(renderer, /out\.unshift\(SIDEBAR_NAV_FIXED_TAB\)/, 'saved legacy order must not move the dashboard');
assert.match(renderer, /if \(idx < 1 \|\| tabId === SIDEBAR_NAV_FIXED_TAB\) return order/, 'the first menu must reject move operations');
assert.match(renderer, /if \(target < 1 \|\| target >= order\.length\) return order/, 'other menus must not move into the fixed first slot');
assert.match(renderer, /setting_sidebar_nav_visibility: '\{\}'/, 'visibility must have a persisted default');
assert.match(renderer, /fixed \? '' : `<div class="settings-menu-order-actions">/, 'the fixed first row must render no actions');
assert.match(renderer, /data-menu-visibility=/, 'all non-fixed rows must expose visibility controls');
assert.match(renderer, /if \(active\)[\s\S]*if \(fixed\) fixed\.click\(\)/, 'hiding the active menu must return to dashboard');
assert.match(styles, /\.sidebar-nav > \.nav-item\.is-menu-hidden\s*\{\s*display: none !important;/, 'hidden menus must be removed from sidebar layout');

console.log('menu visibility guard tests passed');
