'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/share-code.js'), 'utf8');
const sandbox = { window: {}, crypto: webcrypto, Uint8Array, TextEncoder };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const ShareCode = sandbox.window.ShareCode;

test('base32 编解码可以往返', () => {
    for (let length = 1; length <= 20; length++) {
        const bytes = webcrypto.getRandomValues(new Uint8Array(length));
        const encoded = ShareCode.base32Encode(bytes);
        assert.deepEqual(Array.from(ShareCode.base32Decode(encoded)), Array.from(bytes));
    }
});

test('取件码是 26 位、按 5-5-5-5-6 分组', () => {
    const code = ShareCode.generateCode();
    assert.match(code, /^[a-z2-7]{5}-[a-z2-7]{5}-[a-z2-7]{5}-[a-z2-7]{5}-[a-z2-7]{6}$/);
    assert.equal(ShareCode.normalizeCode(code).length, ShareCode.CODE_LENGTH);
    assert.equal(ShareCode.isCode(code), true);
});

test('取件码大小写和分隔符不影响解析', () => {
    const code = ShareCode.generateCode();
    const messy = ` ${code.toUpperCase().replace(/-/g, ' ')} `;
    assert.equal(ShareCode.normalizeCode(messy), ShareCode.normalizeCode(code));
    assert.equal(ShareCode.groupCode(messy), code);
});

test('服务端 ID 由密钥散列得到，稳定且互不相同', async () => {
    const first = ShareCode.generateCode();
    const second = ShareCode.generateCode();
    const firstId = await ShareCode.deriveId(first);
    const secondId = await ShareCode.deriveId(second);

    assert.match(firstId, /^[a-z2-7]{26}$/);
    assert.equal(await ShareCode.deriveId(first), firstId, '同一个码必须得到同一个 ID');
    assert.notEqual(firstId, secondId, '不同码必须得到不同 ID');
    assert.notEqual(firstId, ShareCode.normalizeCode(first), 'ID 不能等于密钥本身');

    const proof = await ShareCode.deriveProof(first);
    assert.match(proof, /^[a-z2-7]{26}$/);
    assert.equal(await ShareCode.deriveProof(first), proof, '同一个码必须得到同一个取件证明');
    assert.notEqual(proof, firstId, '取件证明与路径 ID 必须是两个不同的值');
});
