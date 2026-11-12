'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installation } = require('./helpers/installation');

test('HTTP: page CSP permits locally cached bookmark image blobs', async t => {
    const app = await installation(t);
    await app.start();

    const page = await app.request('/');
    const policy = page.headers.get('content-security-policy') || '';
    assert.match(policy, /img-src[^;]*\bblob:/);
    assert.match(policy, /img-src[^;]*\bhttp:/);
});

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

    const credentials = await app.request(`/api/icon?url=${encodeURIComponent('https://user:secret@example.com/path?q=secret')}`);
    assert.equal(credentials.status, 400);
    const credentialError = await credentials.text();
    assert.ok(!credentialError.includes('secret'));
    const unsupportedPort = await app.request(`/api/icon?url=${encodeURIComponent('https://example.com:8443/')}`);
    assert.equal(unsupportedPort.status, 400);
});

test('HTTP: /api/icon 不代理 loopback 或内网地址', async t => {
    const app = await installation(t);
    await app.start();

    for (const url of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/']) {
        const res = await app.request(`/api/icon?url=${encodeURIComponent(url)}`);
        assert.equal(res.status, 400, `${url} is rejected`);
    }
});

test('HTTP: /api/icon legacy URL parameters are validated before origin normalization', async t => {
    const app = await installation(t);
    await app.start();

    const legacy = await app.request(`/api/icon?url=${encodeURIComponent('http://127.0.0.1/bookmark?private=1#fragment')}`);
    assert.equal(legacy.status, 400);
    const refresh = await app.request(`/api/icon?refresh=1&url=${encodeURIComponent('http://127.0.0.1/')}`);
    assert.equal(refresh.status, 400);
});

test('HTTP: icon traffic has a separate budget from the public-read limit', async t => {
    const app = await installation(t);
    await app.start();

    let last;
    for (let index = 0; index < 125; index++) last = await app.request(`/api/icon?url=${encodeURIComponent('http://127.0.0.1/private')}`);
    assert.equal(last.status, 400, 'the public-read 120/minute gate does not run on /api/icon');
});
