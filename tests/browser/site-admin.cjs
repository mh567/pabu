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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(app.base + '/admin');
    await page.locator('.ui-dialog input[type="password"]').fill('StrongPass123!');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#siteGrid').waitFor({ state: 'visible' });
    return { app, browser, context, page };
}

async function addSiteCategory(page, name) {
    await page.locator('#siteGrid .category-add').click();
    await page.locator('.ui-dialog input').fill(name);
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#siteGrid').getByRole('heading', { name, exact: true }).waitFor();
}

test('browser: remote site update preserves another administrator draft', async t => {
    const { context, page } = await setup(t);
    const other = await context.newPage();
    other.setDefaultTimeout(12000);
    await other.goto(new URL('/admin', page.url()).href);
    await other.locator('#siteGrid').waitFor({ state: 'visible' });

    await addSiteCategory(page, '远端分类');
    await page.locator('#saveBtn').click();
    await page.getByText('站点导航已保存并发布', { exact: true }).waitFor();

    await addSiteCategory(other, '本地草稿');
    await other.evaluate(() => window.app.checkAdministratorSync());
    await other.getByText('站点导航已被其他管理员更新，当前草稿已保留', { exact: true }).waitFor();

    await other.locator('#siteGrid').getByRole('heading', { name: '本地草稿', exact: true }).waitFor();
    assert.equal(await other.locator('#siteGrid').getByRole('heading', { name: '远端分类', exact: true }).count(), 0,
        '草稿未被远端更新覆盖');
});

test('browser: /admin session expiry asks for login without touching local navigation', async t => {
    const { page } = await setup(t);
    await page.evaluate(async () => {
        await fetch('/api/logout', { method: 'POST', headers: { 'X-Pabu-Request': '1', 'Content-Type': 'application/json' }, body: '{}' });
    });
    await page.evaluate(() => { window.app.checkAdministratorSync(); });
    await page.getByText('登录已失效', { exact: true }).waitFor();
    await page.locator('.ui-dialog button[type="button"]').filter({ hasText: '关闭' }).click();
    await page.waitForURL(url => url.pathname === '/');
    await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#adminBtn').count(), 0, '首页不展示管理入口');
});
