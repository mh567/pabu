'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const schema = require('../public/navigation-schema');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const begin = source.indexOf('        async setThemeStyle(style) {');
const end = source.indexOf('        renderThemeStyleSelect(', begin);
assert.ok(begin > 0 && end > begin);
const switchTheme = vm.runInNewContext(`({${source.slice(begin, end)}}).setThemeStyle`, { window: { NavigationSchema: schema }, $: () => null });
function context(overrides = {}) {
    return { config: { theme: 'light', themeStyle: 'prism' }, authenticated: false,
        applyTheme() {}, renderHomeThemeSwitcher() {}, showToast() {},
        async saveLocalNavigation() { return true; }, ...overrides };
}

test('theme switcher: visitor choice is persisted without changing classic brightness', async () => {
    const app = context({ async saveLocalNavigation(config) { assert.equal(config.themeStyle, 'classic'); return true; } });
    await switchTheme.call(app, 'classic');
    assert.equal(app.config.themeStyle, 'classic');
    assert.equal(app.config.theme, 'light');
    assert.equal(app.themeStyleSaving, false);
});

test('theme switcher: failed local write restores the original configuration', async () => {
    const app = context({ async saveLocalNavigation() { return false; } });
    const original = app.config;
    await switchTheme.call(app, 'classic');
    assert.equal(app.config, original);
    assert.equal(app.themeStyleSaving, false);
});

test('theme switcher: administrator also saves locally', async () => {
    let saved = false;
    const app = context({ authenticated: true, async saveLocalNavigation(config) { saved = config.themeStyle === 'classic'; return true; } });
    await switchTheme.call(app, 'classic');
    assert.ok(saved);
});

test('theme switcher: an active draft or invalid theme is never submitted', async () => {
    let saves = 0;
    const app = context({ editLayout: true, async saveLocalNavigation() { saves++; return true; } });
    await switchTheme.call(app, 'classic');
    app.editLayout = false;
    await switchTheme.call(app, 'unknown');
    assert.equal(app.config.themeStyle, 'prism');
    assert.equal(saves, 0);
});

test('theme switcher: administrator identity does not change the save path', async () => {
    let localSaves = 0;
    const app = context({ authenticated: true, async saveLocalNavigation() { localSaves++; return true; } });
    await switchTheme.call(app, 'classic');
    assert.equal(localSaves, 1, '管理员登录后仍写本机导航');
    assert.equal(app.themeStyleSaving, false);
});
