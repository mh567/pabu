'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');

test('browser: engine dropdown animates open, selects, and toggles closed', async t => {
    const app = await installation(t);
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });

    const button = page.locator('#engineBtn');
    const dropdown = page.locator('#engineDropdown');
    await button.click();
    await dropdown.waitFor({ state: 'visible' });
    await dropdown.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.equal(await dropdown.evaluate(el => getComputedStyle(el).animationName), 'dropdown-in');
    assert.equal(await dropdown.evaluate(el => getComputedStyle(el).borderRadius), '12px');
    const buttonBox = await button.boundingBox();
    const menuBox = await dropdown.boundingBox();
    assert.ok(Math.abs(menuBox.x - buttonBox.x) <= 1,
        `下拉左缘应与搜索引擎按钮对齐，实际按钮 ${buttonBox.x}，菜单 ${menuBox.x}`);
    assert.ok(menuBox.y >= buttonBox.y + buttonBox.height,
        '下拉应展开在搜索引擎按钮下方');
    assert.ok(Math.abs(menuBox.width - Math.max(buttonBox.width, 120)) <= 1,
        `下拉宽度应取触发宽度与 120px 的较大者，实际 ${menuBox.width}`);

    const options = dropdown.locator('.engine-option');
    assert.ok(await options.count() >= 2, '默认至少有两个搜索引擎');
    const before = await page.locator('#engineName').innerText();
    await options.nth(1).click();
    await dropdown.waitFor({ state: 'hidden' });
    assert.notEqual(await page.locator('#engineName').innerText(), before, '选择后切换搜索引擎');

    await button.click();
    await dropdown.waitFor({ state: 'visible' });
    await button.click();
    await dropdown.waitFor({ state: 'hidden' });
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
});
