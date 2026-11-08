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
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    return { app, browser, context, page };
}

async function loginAdmin(page) {
    await page.goto(new URL('/admin', page.url()).href);
    await page.locator('.ui-dialog input[type="password"]').fill('StrongPass123!');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#modal').waitFor({ state: 'visible' });
    await page.locator('#siteGrid').waitFor({ state: 'visible' });
}

async function addCategory(page, host, name) {
    if (host === '#siteGrid') await page.locator('#siteGrid .category-add').click();
    else await page.getByRole('button', { name: '＋ 添加分类', exact: true }).click();
    await page.locator('.ui-dialog input').fill(name);
    await page.locator('.ui-dialog button[type="submit"]').click();
}

test('browser: /admin canvas edits the site navigation while the local homepage stays independent', async t => {
    const { app, browser, page } = await setup(t);

    // 先建立本机导航，再登录管理员。
    await page.locator('#layoutBtn').click();
    await addCategory(page, '#grid', '本地保留分类');
    await page.locator('#localDoneBtn').click();
    await page.getByRole('heading', { name: '本地保留分类', exact: true }).waitFor();

    await loginAdmin(page);
    assert.equal(await page.locator('#siteGrid').getByRole('heading', { name: '本地保留分类', exact: true }).count(), 0,
        '站点画布不读取管理员本人的本地导航');

    await addCategory(page, '#siteGrid', '站点新分类');
    await page.locator('#siteGrid').getByRole('heading', { name: '站点新分类', exact: true }).waitFor();
    await page.locator('#saveBtn').click();
    await page.getByText('站点导航已保存并发布', { exact: true }).waitFor();

    const freshContext = await browser.newContext();
    const fresh = await freshContext.newPage();
    await fresh.goto(app.base);
    await fresh.getByRole('heading', { name: '站点新分类', exact: true }).waitFor();
    await freshContext.close();

    // 管理员回到首页，看到的仍是自己的本地导航。
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.getByRole('heading', { name: '本地保留分类', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '站点新分类', exact: true }).count(), 0,
        '管理员登录不切换首页导航');
});

test('browser: Site tab embeds a one-to-one canvas and no longer links to the homepage editor', async t => {
    const { page } = await setup(t);
    await loginAdmin(page);

    await page.locator('#adminTabSite').click();
    assert.equal(await page.locator('#siteGrid').count(), 1, '后台内嵌一比一导航画布');
    assert.equal(await page.locator('#siteCanvas .backboard').count(), 1, '使用首页同一套背板结构');
    assert.equal(await page.locator('#siteCanvas .search-caption').count(), 1, '画布包含搜索说明');
    assert.equal(await page.locator('#siteCanvas .site-footer').count(), 1, '画布包含页脚');
    assert.equal(await page.locator('#siteThemeSwitcher button').count(), 2, '画布包含主题快捷入口');

    await page.locator('#siteThemeSwitcher [data-site-theme="classic"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.themeStyle === 'classic');
    assert.equal(await page.locator('#themeStyleSelect').inputValue(), 'classic', '画布主题与设置同步');

    assert.equal(await page.locator('#editHomepageBtn').count(), 0, '不再跳到首页编辑');
    assert.equal(await page.locator('#adminTabSite').innerText(), '站点导航');
    assert.equal(await page.locator('#adminTabSync').innerText(), '用户与数据');
    assert.equal(await page.locator('#saveBtn').innerText(), '保存并发布');
});
