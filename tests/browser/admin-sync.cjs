'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');
async function setup(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const first = await browser.newContext(), second = await browser.newContext();
    const a = await first.newPage(), b = await second.newPage();
    for (const page of [a, b]) { page.setDefaultTimeout(8000); await page.goto(app.base); await page.locator('#app').waitFor({ state: 'visible' }); }
    return { app, browser, first, second, a, b };
}
async function login(page) {
    await page.locator('#adminBtn').click();
    await page.locator('.ui-dialog input[type="password"]').fill('StrongPass123!');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#modal').waitFor({ state: 'visible' });
    await page.locator('#cancelBtn').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
}
async function category(page, name) {
    await page.locator('#layoutBtn').click();
    await page.getByRole('button', { name: '＋ 添加分类', exact: true }).click();
    await page.locator('.ui-dialog input').fill(name);
    await page.locator('.ui-dialog button[type="submit"]').click();
}
async function check(page) { await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
const heading = (page, name) => page.getByRole('heading', { name, exact: true });
/** 保存并退出编辑。底栏里「编辑」与编辑态的「保存编辑」互斥显示，保存要取另一个元素。 */
const saveEdit = page => page.locator('#localDoneBtn').click();
async function logout(page) {
    await page.locator('#adminBtn').click();
    await page.getByRole('tab', { name: '账户与备份' }).click();
    await page.locator('#logoutBtn').click();
}

test('browser: two clean devices share administrator navigation, retain independent ordinary data and independent sessions', async t => {
    const { a, b } = await setup(t);
    await category(a, 'Ordinary A'); await saveEdit(a);
    await category(b, 'Ordinary B'); await saveEdit(b);
    await login(a); await login(b);
    assert.equal(await heading(a, 'Ordinary A').count(), 0);
    await category(a, 'Shared administrator'); await saveEdit(a);
    await a.getByText('编辑已保存', { exact: true }).waitFor();
    const start = Date.now(); await check(b);
    await heading(b, 'Shared administrator').waitFor();
    assert.ok(Date.now() - start < 2000);
    await logout(a);
    await heading(a, 'Ordinary A').waitFor();
    assert.equal(await heading(a, 'Shared administrator').count(), 0);
    await check(b); await heading(b, 'Shared administrator').waitFor();
    assert.equal(await b.locator('#modeBtn').isVisible(), true);
    await logout(b); await heading(b, 'Ordinary B').waitFor();
});

test('browser: remote updates preserve drafts, conflict saves retain drafts, cancel reconciles latest server configuration', async t => {
    const { a, b } = await setup(t);
    await login(a); await login(b);
    await category(b, 'Local draft');
    await category(a, 'Remote saved'); await saveEdit(a);
    await a.getByText('编辑已保存', { exact: true }).waitFor();
    await check(b);
    await b.getByText(/服务器配置已更新，当前草稿已保留/).waitFor();
    await heading(b, 'Local draft').waitFor();
    await saveEdit(b);
    await b.getByText(/草稿已保留；可取消编辑/).waitFor();
    // 管理员的保存入口在底栏，编辑态下由「编辑」换成「保存编辑」
    assert.equal(await b.locator('#localDoneBtn').textContent(), '保存编辑');
    await heading(b, 'Local draft').waitFor();
    await b.keyboard.press('Escape');
    await b.locator('.ui-dialog button[type="submit"]').click();
    await heading(b, 'Remote saved').waitFor();
    assert.equal(await heading(b, 'Local draft').count(), 0);
});

test('browser: network errors preserve identity, expiration hides private draft and relogin restores its original revision', async t => {
    const { app, a } = await setup(t);
    await login(a); await category(a, 'Retained private draft');
    await a.route('**/api/session', route => route.abort());
    await check(a); await a.getByText('暂时无法同步，联网后重试', { exact: true }).waitFor();
    await heading(a, 'Retained private draft').waitFor();
    await a.unroute('**/api/session');
    // Revoke this device through the actual public logout endpoint.
    await a.evaluate(async () => { await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pabu-Request': '1' }, body: '{}' }); });
    await check(a);
    await a.getByText('登录已失效', { exact: true }).waitFor();
    assert.equal(await a.locator('#appearanceBtn').isDisabled(), true);
    assert.equal(await a.locator('#engineBtn').isDisabled(), true);
    assert.equal(await heading(a, 'Retained private draft').count(), 0);
    assert.equal(await a.locator('#modeBtn').isVisible(), false);
    await a.locator('.ui-dialog button[type="submit"]').click();
    await a.locator('.ui-dialog input[type="password"]').fill('StrongPass123!');
    await a.locator('.ui-dialog button[type="submit"]').click();
    await a.locator('#modal').waitFor({ state: 'visible' });
    await a.locator('#cancelBtn').click();
    await heading(a, 'Retained private draft').waitFor();
    await saveEdit(a);
    await a.getByText('编辑已保存', { exact: true }).waitFor();
    await a.reload(); await heading(a, 'Retained private draft').waitFor();
});

test('browser: visible administrator device receives a saved update within the 32 second polling target', async t => {
    const { a, b } = await setup(t);
    await login(a); await login(b);
    // Save immediately after a natural polling response to exercise the longest wait.
    await b.waitForResponse(response => response.url().endsWith('/api/session'), { timeout: 32000 });
    await category(a, 'Periodic update'); await saveEdit(a);
    await a.getByText('编辑已保存', { exact: true }).waitFor();
    const start = Date.now();
    await heading(b, 'Periodic update').waitFor({ timeout: 32500 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed <= 32000, `polling propagation took ${elapsed} ms`);
    console.log(`visible polling propagation: ${elapsed} ms`);
});

test('browser: shared-cookie tabs handle ordinary drafts before login and retain administrator drafts on another tab logout', async t => {
    const { app, a, first } = await setup(t);
    const tab = await first.newPage(); tab.setDefaultTimeout(8000);
    await tab.goto(app.base); await tab.locator('#app').waitFor({ state: 'visible' });
    await category(tab, 'Ordinary tab data');
    await login(a);
    await tab.getByText(/管理员会话已确认，请完成当前编辑/).waitFor();
    await heading(tab, 'Ordinary tab data').waitFor();
    await saveEdit(tab);
    await tab.locator('#modeBtn').waitFor({ state: 'visible' });
    assert.equal(await heading(tab, 'Ordinary tab data').count(), 0);
    await category(tab, 'Unsubmitted admin data');
    await logout(a);
    await tab.getByText('登录已失效', { exact: true }).waitFor();
    assert.equal(await heading(tab, 'Unsubmitted admin data').count(), 0);
    await tab.getByRole('button', { name: '放弃草稿', exact: true }).click();
    await tab.locator('.ui-dialog button[type="submit"]').click();
    await heading(tab, 'Ordinary tab data').waitFor();
    assert.equal(await tab.locator('#modeBtn').isVisible(), false);
});

test('browser: personal engine definitions propagate and a late administrator response cannot replace the ordinary context after logout', async t => {
    const { a, b } = await setup(t);
    await category(a, 'Ordinary late-response baseline'); await saveEdit(a);
    await login(a); await login(b);
    await a.locator('#adminBtn').click();
    await a.locator('[aria-controls="enginesSection"]').click(); await a.locator('#addEngine').click();
    const engine = a.locator('#enginesEditor .item').last();
    await engine.locator('[data-field="name"]').fill('Synced engine');
    await engine.locator('[data-field="url"]').fill('https://example.com/?q=');
    await a.locator('#saveBtn').click();
    await a.getByText('设置已保存到服务器', { exact: true }).waitFor();
    await check(b);
    await b.locator('#adminBtn').click();
    await b.locator('[aria-controls="enginesSection"]').click();
    await b.locator('#enginesEditor input[value="Synced engine"]').waitFor();
    await b.locator('#cancelBtn').click();
    let release, fetched;
    const ready = new Promise(resolve => { fetched = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let held = false;
    await a.route('**/api/admin/navigation', async route => {
        if (held || route.request().method() !== 'GET') return route.continue();
        held = true;
        const response = await route.fetch(); fetched(); await gate; await route.fulfill({ response });
    });
    await check(a); await ready;
    await logout(a);
    await heading(a, 'Ordinary late-response baseline').waitFor();
    release(); await a.unrouteAll({ behavior: 'wait' });
    await heading(a, 'Ordinary late-response baseline').waitFor();
    assert.equal(await a.locator('#modeBtn').isVisible(), false);
    assert.notEqual(await a.locator('#engineName').textContent(), 'Synced engine');
});
