'use strict';
// 手动基准：node --test tests/browser/rtc-throughput.cjs
// 需要 Playwright 可用，并使用系统 Chrome（channel: 'chrome'）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');

const SIZE = 16 * 1024 * 1024;
const MB = 1024 * 1024;

function makePayload() {
    const buffer = Buffer.allocUnsafe(SIZE);
    for (let index = 0; index < SIZE; index++) buffer[index] = (index * 31 + (index >>> 13)) & 0xff;
    return buffer;
}

test('browser: 同机直连完成并保持内容一致', async t => {
    const app = await installation(t);
    await app.start();
    const senderBrowser = await chromium.launch({ headless: true, channel: 'chrome' });
    const receiverBrowser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => senderBrowser.close());
    t.after(() => receiverBrowser.close());

    const senderContext = await senderBrowser.newContext({ acceptDownloads: true });
    const receiverContext = await receiverBrowser.newContext({ acceptDownloads: true });
    t.after(() => senderContext.close());
    t.after(() => receiverContext.close());
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    sender.setDefaultTimeout(20000);
    receiver.setDefaultTimeout(20000);
    for (const [name, page] of [['sender', sender], ['receiver', receiver]]) {
        page.on('console', message => {
            if (message.type() === 'error' || message.type() === 'warning') {
                console.log(`[${name}] ${message.type()}: ${message.text()}`);
            }
        });
        page.on('pageerror', error => console.log(`[${name}] pageerror: ${error.message}`));
    }

    await Promise.all([sender.goto(app.base), receiver.goto(app.base)]);
    await Promise.all([
        sender.locator('#searchInput').waitFor({ state: 'visible' }),
        receiver.locator('#searchInput').waitFor({ state: 'visible' })
    ]);

    await sender.evaluate(() => {
        const transfer = window.RtcTransfer;
        window.__bench = {};
        const start = transfer.startSending.bind(transfer);
        transfer.startSending = async function () {
            window.__bench.start = performance.now();
            try { return await start(); }
            finally { window.__bench.end = performance.now(); }
        };
    });
    await receiver.evaluate(() => {
        const transfer = window.RtcTransfer;
        window.__bench = {};
        const onMessage = transfer.onChannelMessage.bind(transfer);
        transfer.onChannelMessage = function (data) {
            if (!window.__bench.start) window.__bench.start = performance.now();
            return onMessage(data);
        };
        const finish = transfer.finishReceive.bind(transfer);
        transfer.finishReceive = async function () {
            window.__bench.done = performance.now();
            return finish();
        };
    });

    const payload = makePayload();
    await sender.setInputFiles('#transferFileInput', {
        name: 'benchmark.bin',
        mimeType: 'application/octet-stream',
        buffer: payload
    });
    await sender.locator('.rtc-code').waitFor({ state: 'visible' });
    const code = (await sender.locator('.rtc-code').innerText()).trim();
    assert.match(code, /^[1-9]\d{4}$/);

    await receiver.locator('#searchInput').fill(code);
    await receiver.locator('#searchInput').press('Enter');
    await receiver.locator('.rtc-file').waitFor({ state: 'visible' });
    await sender.locator('button[data-action="send"]').waitFor({ state: 'visible', timeout: 30000 });
    await receiver.locator('.rtc-verify strong').waitFor({ state: 'visible', timeout: 60000 });

    const startedAt = Date.now();
    const downloadPromise = receiver.waitForEvent('download', { timeout: 60000 });
    await sender.locator('button[data-action="send"]').click();
    let download;
    try {
        download = await downloadPromise;
    } catch (error) {
        console.log('[bench] sender body:', await sender.locator('.rtc-body').innerText().catch(() => ''));
        console.log('[bench] receiver body:', await receiver.locator('.rtc-body').innerText().catch(() => ''));
        console.log('[bench] sender stats:', await sender.locator('.rtc-stats').innerText().catch(() => ''));
        console.log('[bench] receiver stats:', await receiver.locator('.rtc-stats').innerText().catch(() => ''));
        throw error;
    }
    const downloadMs = Date.now() - startedAt;
    console.log(`[bench] download event ${(SIZE / MB / (downloadMs / 1000)).toFixed(1)} MiB/s over ${downloadMs} ms`);
    const savePath = path.join(app.dir, 'benchmark-download.bin');
    await download.saveAs(savePath);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[bench] end-to-end ${(SIZE / MB / (elapsedMs / 1000)).toFixed(1)} MiB/s over ${elapsedMs} ms`);

    const senderBench = await sender.evaluate(() => window.__bench);
    const receiverBench = await receiver.evaluate(() => window.__bench);
    if (senderBench.start && senderBench.end) {
        const ms = senderBench.end - senderBench.start;
        console.log(`[bench] sender loop ${(SIZE / MB / (ms / 1000)).toFixed(1)} MiB/s over ${ms.toFixed(0)} ms`);
    }
    if (receiverBench.start && receiverBench.done) {
        const ms = receiverBench.done - receiverBench.start;
        console.log(`[bench] receiver loop ${(SIZE / MB / (ms / 1000)).toFixed(1)} MiB/s over ${ms.toFixed(0)} ms`);
    }

    const saved = fs.readFileSync(savePath);
    assert.equal(saved.length, SIZE);
    assert.equal(
        crypto.createHash('sha256').update(saved).digest('hex'),
        crypto.createHash('sha256').update(payload).digest('hex')
    );

    const mibPerSecond = SIZE / MB / (elapsedMs / 1000);
    console.log(`[rtc-bench] ${mibPerSecond.toFixed(1)} MiB/s, ${elapsedMs} ms, ${SIZE / MB} MiB`);
});
