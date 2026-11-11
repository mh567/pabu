'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { installation } = require('./helpers/installation');

test('HTTP: /api/icon 校验 URL 参数，过滤非法请求', async t => {
    const app = await installation(t);
    await app.start();

    // 缺少 url 参数
    const noUrl = await app.request('/api/icon');
    assert.equal(noUrl.status, 400);

    // 非法协议
    const ftp = await app.request('/api/icon?url=ftp://example.com/file');
    assert.equal(ftp.status, 400);

    // 云元数据 SSRF 拦截
    const meta = await app.request('/api/icon?url=http://169.254.169.254/latest/meta-data/');
    assert.equal(meta.status, 400);
});

test('HTTP: /api/icon 成功返回真实图标并携带缓存与安全头', async t => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    // 搭建真实的本地测试源站
    const targetServer = http.createServer((req, res) => {
        if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<!DOCTYPE html><html><head><link rel="icon" href="/logo.png"></head></html>');
        }
        if (req.url === '/logo.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            return res.end(pngBytes);
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise(r => targetServer.listen(0, '127.0.0.1', r));
    const targetPort = targetServer.address().port;
    t.after(() => new Promise(r => targetServer.close(r)));

    const app = await installation(t);
    await app.start();

    const res = await app.request(`/api/icon?url=${encodeURIComponent(`http://127.0.0.1:${targetPort}/`)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control'), /public/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, pngBytes);
});

test('HTTP: /api/icon 未找到图标时返回 404', async t => {
    // 搭建无图标的测试源站
    const emptyServer = http.createServer((req, res) => {
        res.writeHead(404);
        res.end();
    });
    await new Promise(r => emptyServer.listen(0, '127.0.0.1', r));
    const emptyPort = emptyServer.address().port;
    t.after(() => new Promise(r => emptyServer.close(r)));

    const app = await installation(t);
    await app.start();

    const res = await app.request(`/api/icon?url=${encodeURIComponent(`http://127.0.0.1:${emptyPort}/`)}`);
    assert.equal(res.status, 404);
});
