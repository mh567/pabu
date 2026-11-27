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
    assert.match(html, /deriveShortKey/);
});

test('浏览器端生成 6 位短码、散列 ID 并把短码放进 fragment', () => {
    assert.match(app, /ShareCode\.generateShortCode\(\)/);
    assert.match(app, /await ShareCode\.deriveId\(code\)/);
    assert.match(app, /Crypto\.encryptWithShortCode\(content, code, pin \|\| ''\)/);
    assert.match(app, /ShareCode\.deriveProof\(code\)/);
    assert.match(app, /const body = \{ code: id, content: encryptedContent, proof \}/);
    assert.match(app, /\/p\/\$\{id\}#\$\{code\}/);
    assert.equal(app.includes("fetch('/api/p/code'"), false, '文本分享不再向服务端申请短码');
});

test('取件码输入支持 6 位短码并按散列 ID 跳转', () => {
    assert.match(app, /parsePickup\(text\)/);
    assert.match(app, /ShareCode\.isShortCode\(raw\)/);
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

test('HTTP text share v2: 连续多次失败取件会触发失败限流 429', async t => {
    const appUnderTest = await installation(t);
    await appUnderTest.start();

    for (let i = 0; i < 10; i++) {
        const res = await appUnderTest.request(`/api/p/${ID}`, { body: { proof: PROOF } });
        assert.equal(res.status, 404);
    }
    const blocked = await appUnderTest.request(`/api/p/${ID}`, { body: { proof: PROOF } });
    assert.equal(blocked.status, 429);
});

test('HTTP text share v2: 6 位短码 + PIN 端到端加密上传与取回解密闭环', async t => {
    const vm = require('node:vm');
    const { webcrypto } = require('node:crypto');
    const shareCodeSrc = fs.readFileSync(path.join(__dirname, '..', 'public/share-code.js'), 'utf8');
    const sandbox = { window: {}, crypto: webcrypto, Uint8Array, Uint32Array, TextEncoder };
    vm.createContext(sandbox);
    vm.runInContext(shareCodeSrc, sandbox);
    const ShareCode = sandbox.window.ShareCode;

    const shortCode = ShareCode.generateShortCode();
    const id = await ShareCode.deriveId(shortCode);
    const proof = await ShareCode.deriveProof(shortCode);
    const pin = '7391';
    const plain = '手机发送到电脑的测试文本 123!';

    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const material = await webcrypto.subtle.importKey(
        'raw', new TextEncoder().encode(`${shortCode}:${pin}`), 'PBKDF2', false, ['deriveKey']
    );
    const aesKey = await webcrypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
    const encrypted = await webcrypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plain)
    );
    const payload = `s1:${Buffer.from(salt).toString('base64')}:${Buffer.from(iv).toString('base64')}:${Buffer.from(encrypted).toString('base64')}`;

    const appUnderTest = await installation(t);
    await appUnderTest.start();

    const created = await appUnderTest.request('/api/p', {
        body: { code: id, content: payload, pin, ttl: 5, proof }
    });
    assert.equal(created.status, 200);

    const fetched = await appUnderTest.request(`/api/p/${id}`, {
        body: { pin, proof }
    });
    assert.equal(fetched.status, 200);
    const { content } = await fetched.json();
    assert.equal(content, payload);

    const parts = content.split(':');
    const decMaterial = await webcrypto.subtle.importKey(
        'raw', new TextEncoder().encode(`${shortCode}:${pin}`), 'PBKDF2', false, ['deriveKey']
    );
    const decKey = await webcrypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: Buffer.from(parts[1], 'base64'), iterations: 100000, hash: 'SHA-256' },
        decMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
    );
    const decrypted = await webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(parts[2], 'base64') },
        decKey,
        Buffer.from(parts[3], 'base64')
    );
    assert.equal(new TextDecoder().decode(decrypted), plain);
});

test('HTTP text share v2: 单 IP 错 3 次 PIN 只锁定该 IP，不删除分享记录', async t => {
    const appUnderTest = await installation(t);
    await appUnderTest.start();

    const created = await appUnderTest.request('/api/p', {
        body: { code: ID, content: 'keep-alive-cipher', pin: '2468', ttl: 5, proof: PROOF }
    });
    assert.equal(created.status, 200);

    for (let i = 0; i < 2; i++) {
        const res = await appUnderTest.request(`/api/p/${ID}`, { body: { pin: '0000', proof: PROOF } });
        assert.equal(res.status, 403);
    }
    // 第 3 次错误直接锁定该 IP（429），且后续用正确 PIN 仍被该 IP 锁定拦截，但记录本身未删除
    const third = await appUnderTest.request(`/api/p/${ID}`, { body: { pin: '0000', proof: PROOF } });
    assert.equal(third.status, 429);
    const lockedCorrect = await appUnderTest.request(`/api/p/${ID}`, { body: { pin: '2468', proof: PROOF } });
    assert.equal(lockedCorrect.status, 429);

    // 换一个客户端 IP 仍可用正确 PIN 正常取回并阅后即焚
    const otherIp = await fetch(`${appUnderTest.base}/api/p/${ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
        body: JSON.stringify({ pin: '2468', proof: PROOF })
    });
    assert.equal(otherIp.status, 200);
    assert.equal((await otherIp.json()).content, 'keep-alive-cipher');
});

test('HTTP text share v2: GET /p/:code 连续探测不存在记录会触发 429', async t => {
    const appUnderTest = await installation(t);
    await appUnderTest.start();

    for (let i = 0; i < 10; i++) {
        const res = await fetch(`${appUnderTest.base}/p/${ID}`);
        assert.equal(res.status, 200);
    }
    const blocked = await fetch(`${appUnderTest.base}/p/${ID}`);
    assert.equal(blocked.status, 429);
});
