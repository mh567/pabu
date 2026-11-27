'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/share-code.js'), 'utf8');
const sandbox = { window: {}, crypto: webcrypto, Uint8Array, Uint32Array, TextEncoder };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const ShareCode = sandbox.window.ShareCode;

test('base32 编码输出 26 位小写字母数字字符', () => {
    const bytes = webcrypto.getRandomValues(new Uint8Array(16));
    const encoded = ShareCode.base32Encode(bytes);
    assert.match(encoded, /^[a-z2-7]{26}$/);
});

test('实时取件码只接受 5 位且首位不为 0', () => {
    assert.equal(ShareCode.isRtcCode('12345'), true);
    assert.equal(ShareCode.isRtcCode(12345), false, '数字类型不当作码');
    assert.equal(ShareCode.isRtcCode('01234'), false);
    assert.equal(ShareCode.isRtcCode('1234'), false);
    assert.equal(ShareCode.isRtcCode('123456'), false);
    assert.equal(ShareCode.isRtcCode(' 12345 '), false);
    assert.equal(ShareCode.isRtcCode(''), false);
});

test('6 位短码生成、格式化、识别与散列派生正常', async () => {
    const shortCode = ShareCode.generateShortCode();
    assert.match(shortCode, /^\d{6}$/);
    assert.equal(ShareCode.isShortCode(shortCode), true);
    assert.equal(ShareCode.isShortCode(ShareCode.formatShortCode(shortCode)), true);
    assert.equal(ShareCode.isShortCode('012345'), true);
    assert.equal(ShareCode.isShortCode('482-915'), true);
    assert.equal(ShareCode.isShortCode(482915), false, '数字类型不当作码');
    assert.equal(ShareCode.isShortCode('12345'), false, '5 位留给实时文件码');
    assert.equal(ShareCode.isShortCode('1234567'), false);
    assert.equal(ShareCode.isShortCode('12345a'), false);
    assert.equal(ShareCode.isRtcCode(shortCode), false);

    const shortId = await ShareCode.deriveId(shortCode);
    const shortProof = await ShareCode.deriveProof(shortCode);
    assert.match(shortId, /^[a-z2-7]{26}$/);
    assert.match(shortProof, /^[a-z2-7]{26}$/);
    assert.notEqual(shortId, shortProof);
    assert.equal(await ShareCode.deriveId(ShareCode.formatShortCode(shortCode)), shortId);
});
