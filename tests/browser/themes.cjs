'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');
const localSelect = require('../helpers/local-select.cjs');
const shots = path.join(__dirname, '../../.impeccable/review');

async function fixture(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    return { app, browser, context, page };
}
async function appearance(page, style, mode) {
    await page.waitForFunction(({ style, mode }) => document.documentElement.dataset.themeStyle === style && (document.documentElement.dataset.theme || 'auto') === mode, { style, mode });
}
async function login(page) {
    await page.goto(new URL('/admin', page.url()).href);
    await page.locator('.ui-dialog input[type="password"]').fill('StrongPass123!');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#modal').waitFor({ state: 'visible' });
}
async function saveAdmin(page) {
    const response = page.waitForResponse(r => r.url().endsWith('/api/admin/navigation') && r.request().method() === 'POST');
    await page.locator('#saveBtn').click();
    assert.equal((await response).status(), 200);
    await page.getByText('站点导航设置已保存', { exact: true }).waitFor();
    await page.goto(new URL('/', page.url()).href);
    await page.locator('#app').waitFor({ state: 'visible' });
}

test('browser: 访客主题真实保存、取消、重载、离线回访与经典明暗偏好恢复', async t => {
    const { page, context } = await fixture(t);
    await page.locator('#layoutBtn').click();
    await localSelect(page, 'localThemeStyleSelect', 'classic');
    await localSelect(page, 'localThemeSelect', 'light');
    await localSelect(page, 'localThemeStyleSelect', 'prism');
    assert.equal(await page.locator('#localThemeSelect').isDisabled(), true);
    await page.locator('#localDoneBtn').click();
    await appearance(page, 'prism', 'dark');
    await page.reload();
    await appearance(page, 'prism', 'dark');
    await context.setOffline(true);
    await page.reload();
    await appearance(page, 'prism', 'dark');
    await context.setOffline(false);
    await page.locator('#layoutBtn').click();
    await localSelect(page, 'localThemeStyleSelect', 'classic');
    await page.locator('#localCancelBtn').click();
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#localNavigationTools').waitFor({ state: 'hidden' });
    await appearance(page, 'prism', 'dark');
    await page.locator('#layoutBtn').click();
    await localSelect(page, 'localThemeStyleSelect', 'classic');
    assert.equal(await page.locator('#localThemeSelect').isDisabled(), false);
    assert.equal(await page.locator('#localThemeSelect').inputValue(), 'light');
    await page.locator('#localDoneBtn').click();
    await appearance(page, 'classic', 'light');
    await page.reload();
    await appearance(page, 'classic', 'light');
});

test('browser: first visit uses prism and the top dropdown persists explicit choices', async t => {
    const { page } = await fixture(t);
    await appearance(page, 'prism', 'dark');
    const trigger = page.locator('#homeThemeSwitcherTrigger');
    const menu = page.locator('#homeThemeSwitcherMenu');
    assert.equal((await trigger.textContent()).trim(), '棱镜');
    const box = await trigger.boundingBox();
    const search = await page.locator('#searchForm').boundingBox();
    assert.ok(box.y + box.height <= search.y);
    await trigger.click();
    await menu.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#homeThemeSwitcherTrigger')?.getAttribute('aria-expanded') === 'true');
    assert.equal(await page.locator('[data-home-theme="prism"]').getAttribute('aria-selected'), 'true');
    await page.locator('[data-home-theme="classic"]').click();
    await menu.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !window.app.themeStyleSaving);
    await appearance(page, 'classic', 'auto');
    await page.reload();
    await appearance(page, 'classic', 'auto');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await menu.waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await menu.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !window.app.themeStyleSaving);
    await appearance(page, 'prism', 'dark');
    await page.locator('#layoutBtn').click();
    assert.equal(await trigger.isDisabled(), true);
    await page.locator('#localCancelBtn').click();
    await page.locator('#localNavigationTools').waitFor({ state: 'hidden' });
    assert.equal(await trigger.isEnabled(), true);
});
