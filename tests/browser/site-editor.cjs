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
    page.setDefaultTimeout(10000);
    await page.goto(app.base + '/admin');
    await page.locator('.ui-dialog input[type="password"]').fill('StrongPass123!');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#modal').waitFor({ state: 'visible' });
    return { app, browser, context, page };
}

test('browser: administrator edits the real homepage and saving publishes the site navigation', async t => {
    const { app, browser, page } = await setup(t);

    await page.locator('#editHomepageBtn').click();
    await page.waitForURL(url => url.pathname === '/');
    await page.locator('#grid.is-editing').waitFor();

    await page.getByRole('button', { name: '＋ 添加分类', exact: true }).click();
    await page.locator('.ui-dialog input').fill('站点新分类');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.getByRole('heading', { name: '站点新分类', exact: true }).waitFor();

    const save = page.locator('#localDoneBtn');
    assert.equal(await save.textContent(), '保存并发布');
    await save.click();
    await page.getByText('站点导航已保存并发布', { exact: true }).waitFor();
    await page.locator('#grid.is-editing').waitFor({ state: 'detached' });

    const freshContext = await browser.newContext();
    const fresh = await freshContext.newPage();
    await fresh.goto(app.base);
    await fresh.getByRole('heading', { name: '站点新分类', exact: true }).waitFor();
    await freshContext.close();
});

test('browser: /admin site tab links to the homepage editor and no longer embeds a template canvas', async t => {
    const { page } = await setup(t);

    await page.locator('#adminTabSite').click();
    await page.locator('#editHomepageBtn').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#templateGrid').count(), 0, '后台不再内嵌导航画布');
    assert.equal(await page.locator('#templatePublishBtn').count(), 0, '后台不再有单独发布按钮');
    assert.equal(await page.locator('#adminTabSync').innerText(), '用户与数据');
});
