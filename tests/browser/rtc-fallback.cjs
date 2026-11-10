'use strict';
// Run with Playwright available in NODE_PATH:
// node --test tests/browser/rtc-fallback.cjs
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');

const CONTENT = 'relay fallback content\n第二行\n';

test('browser: relay fallback uploads and downloads after direct connection is abandoned', async t => {
    const app = await installation(t);
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());

    const senderContext = await browser.newContext({ acceptDownloads: true });
    const receiverContext = await browser.newContext({ acceptDownloads: true });
    t.after(() => senderContext.close());
    t.after(() => receiverContext.close());
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    sender.setDefaultTimeout(15000);
    receiver.setDefaultTimeout(15000);

    await Promise.all([sender.goto(app.base), receiver.goto(app.base)]);
    await Promise.all([
        sender.locator('#searchInput').waitFor({ state: 'visible' }),
        receiver.locator('#searchInput').waitFor({ state: 'visible' })
    ]);

    await sender.setInputFiles('#transferFileInput', {
        name: 'fallback.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(CONTENT, 'utf8')
    });
    await sender.locator('.rtc-code').waitFor({ state: 'visible' });
    const code = (await sender.locator('.rtc-code').innerText()).trim();
    assert.match(code, /^[1-9]\d{4}$/);

    await receiver.locator('#searchInput').fill(code);
    await receiver.locator('#searchInput').press('Enter');
    await receiver.locator('.rtc-file').waitFor({ state: 'visible' });
    await sender.locator('button[data-action="send"]').waitFor({ state: 'visible', timeout: 30000 });
    await receiver.locator('.rtc-verify strong').waitFor({ state: 'visible', timeout: 20000 });

    const downloadPromise = receiver.waitForEvent('download', { timeout: 30000 }).catch(error => error);
    await sender.locator('button[data-action="fallback"]').first().click();

    // 发送方切中转后，接收方应该停在等待取件码的状态，而不是闪出断线错误。
    await receiver.getByText('发送方正在改用服务器中转', { exact: false }).waitFor({ state: 'visible' });
    assert.equal(await receiver.getByText('连接已断开，请让发送方重新分享', { exact: false }).count(), 0);

    const upload = sender.locator('.ui-dialog button', { hasText: '上传' }).first();
    await upload.waitFor({ state: 'visible' });
    await upload.click();
    await sender.locator('.paste-result').waitFor({ state: 'visible', timeout: 30000 });
    const relayCode = (await sender.locator('.paste-code').innerText()).trim();
    assert.match(relayCode, /^[a-z]{2,6}-\d{3}$/);

    await receiver.waitForURL(new RegExp(`/f/${relayCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), { timeout: 30000 });
    await receiver.locator('#downloadBtn').waitFor({ state: 'visible' });
    await receiver.locator('#downloadBtn').click();
    const download = await downloadPromise;
    if (download instanceof Error) throw download;
    const savePath = path.join(app.dir, 'fallback-download.txt');
    await download.saveAs(savePath);
    assert.equal(fs.readFileSync(savePath, 'utf8'), CONTENT);
});
