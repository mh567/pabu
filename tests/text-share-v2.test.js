'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installation } = require('./helpers/installation');

const app = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const ID = 'abcdefghijklmnopqrstuvwxyz';
const PROOF = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const WRONG_PROOF = 'cccccccccccccccccccccccccc';

test('HTTP text share v2: 26 位散列 ID 可以创建并取回一次', async t => {
    const appUnderTest = await installation(t);
    await appUnderTest.start();

    const created = await appUnderTest.request('/api/p', {
        body: { code: ID, content: 'v2-ciphertext', pin: '2468', ttl: 5, proof: PROOF }
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).success, true);

    const needsPin = await appUnderTest.request(`/api/p/${ID}`, { body: { proof: PROOF } });
    assert.equal((await needsPin.json()).requirePin, true);

    // 只有路径 ID 没有取件证明时不能试 PIN，更不能删除记录。
    const noProof = await appUnderTest.request(`/api/p/${ID}`, { body: { pin: '2468' } });
    assert.equal(noProof.status, 403);
    const wrongProof = await appUnderTest.request(`/api/p/${ID}`, { body: { pin: '2468', proof: WRONG_PROOF } });
    assert.equal(wrongProof.status, 403);

    const fetched = await appUnderTest.request(`/api/p/${ID}`, { body: { pin: '2468', proof: PROOF } });
    assert.equal((await fetched.json()).content, 'v2-ciphertext');
    assert.equal((await appUnderTest.request(`/api/p/${ID}`, { body: { pin: '2468', proof: PROOF } })).status, 404);
});

test('HTTP text share v2: 非法 ID 仍被拒绝', async t => {
    const appUnderTest = await installation(t);
    await appUnderTest.start();
    const response = await appUnderTest.request('/api/p', {
        body: { code: 'tooshort', content: 'x', ttl: 5 }
    });
    assert.equal(response.status, 400);
});

test('分享页加载共享码模块，缺 fragment 时不去取件', async t => {
    const appUnderTest = await installation(t);
    await appUnderTest.start();
    await appUnderTest.request('/api/p', { body: { code: ID, content: 'cipher', ttl: 5 } });

    const page = await fetch(`${appUnderTest.base}/p/${ID}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<script src="\/share-code\.js"><\/script>/);
    assert.match(html, /needsShareKey/);
    assert.match(html, /verifyShareKey/);
    assert.match(html, /getShareProof/);
    assert.match(html, /请使用完整分享链接取回内容/);
    assert.equal(html.includes('PBKDF2'), false, '分享页不再保留旧短码派生');
});

test('浏览器端生成密钥、散列 ID 并把密钥放进 fragment', () => {
    assert.match(app, /ShareCode\.generateCode\(\)/);
    assert.match(app, /await ShareCode\.deriveId\(code\)/);
    assert.match(app, /Crypto\.encryptWithCode\(content, code\)/);
    assert.match(app, /ShareCode\.deriveProof\(code\)/);
    assert.match(app, /const body = \{ code: id, content: encryptedContent, proof \}/);
    assert.match(app, /\/p\/\$\{id\}#\$\{ShareCode\.normalizeCode\(code\)\}/);
    assert.equal(app.includes("fetch('/api/p/code'"), false, '文本分享不再向服务端申请短码');
});

test('取件码输入仍支持分组密钥并按散列 ID 跳转', () => {
    assert.match(app, /parsePickup\(text\)/);
    assert.match(app, /ShareCode\.isCode\(raw\)/);
    assert.match(app, /location\.assign\(`\/p\/\$\{await ShareCode\.deriveId\(pickup\.code\)\}#\$\{pickup\.code\}`\)/);
    assert.match(app, /仅支持本站分享链接/);
});

test('服务端只接受新 ID，旧文本短码不再兼容', () => {
    assert.match(server, /function isShareIdFormat\(str\) \{\s*return \/\^\[a-z2-7\]\{26\}\$\/\.test\(str\);/);
    assert.equal(/isPasteCodeFormat\(str\)\s*\|\|/.test(server), false);
    assert.equal(server.includes("app.post('/api/p/code'"), false);
    // 单词码仍然用于文件分享的取件路由。
    assert.match(server, /app\.get\('\/f\/:code'/);
});

test('HTTP text share v2: 旧单词码既不能创建也不能渲染', async t => {
    const appUnderTest = await installation(t);
    await appUnderTest.start();

    const created = await appUnderTest.request('/api/p', {
        body: { code: 'tiger-123', content: 'legacy', ttl: 5 }
    });
    assert.equal(created.status, 400);

    const page = await fetch(`${appUnderTest.base}/p/tiger-123`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/');
});
