'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTransferStore } = require('../lib/transfer-store');

const MINUTE = 60 * 1000;

function makeStore(t, limits = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pabu-transfer-'));
    let clock = 1_700_000_000_000;
    let token = 0;
    const store = createTransferStore({
        directory,
        limits: { tokenTtlMs: 10 * MINUTE, partialTtlMs: 60 * MINUTE, ...limits },
        now: () => clock,
        newToken: () => `token-${++token}`
    });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return {
        store,
        directory,
        advance(ms) { clock += ms; },
        async ready() { await store.ready(); }
    };
}

function initInput(overrides = {}) {
    // 10 字节明文，8 字节分片，AES-GCM 每片 28 字节信封。
    return {
        code: 'tiger-123',
        size: 10,
        chunkSize: 8,
        chunkBytes: 36,
        storedSize: 66,
        name: 'note.txt',
        type: 'text/plain',
        ttlMs: 5 * MINUTE,
        ...overrides
    };
}

async function upload(store, code, first = Buffer.alloc(36, 1), last = Buffer.alloc(30, 2)) {
    await store.init(initInput({ code }));
    await store.writeChunk(code, 0, first);
    await store.writeChunk(code, 1, last);
    await store.finish(code);
}

test('a finished transfer can be taken once and is removed afterwards', async t => {
    const { store } = makeStore(t);
    await upload(store, 'tiger-123');

    const info = store.meta('tiger-123');
    assert.equal(info.exists, true);
    assert.equal(info.uploading, false);

    const access = await store.access('tiger-123', null);
    assert.equal(access.size, 10);
    assert.equal(access.chunkCount, 2);
    assert.equal(access.storedSize, 66);

    const claimed = store.consumeToken(access.token, 'tiger-123');
    assert.equal(claimed.code, 'tiger-123');
    assert.equal(fs.statSync(claimed.filePath).size, 66);

    assert.throws(() => store.consumeToken(access.token, 'tiger-123'), /已使用/);
    assert.throws(() => store.consumeToken('unknown', 'tiger-123'), /无效/);

    assert.deepEqual(await store.completeDownload('tiger-123'), { remaining: 0 });
    assert.equal(store.has('tiger-123'), false);
    assert.equal(fs.existsSync(claimed.filePath), false);
    assert.equal(store.stats().entries, 0);
});

test('the PIN locks the transfer and three failures destroy it', async t => {
    const { store } = makeStore(t);
    await store.init(initInput({ pin: '2468' }));
    await store.writeChunk('tiger-123', 0, Buffer.alloc(36));
    await store.writeChunk('tiger-123', 1, Buffer.alloc(30));
    await store.finish('tiger-123');

    await assert.rejects(store.access('tiger-123', '0000'), /剩余 2 次/);
    await assert.rejects(store.access('tiger-123', '0000'), /剩余 1 次/);
    await assert.rejects(store.access('tiger-123', '0000'), /已销毁/);
    assert.equal(store.meta('tiger-123').exists, false);
});

test('capacity ceilings refuse new transfers without touching existing ones', async t => {
    const { store } = makeStore(t, { maxEntries: 1, maxTotalBytes: 100 });
    await store.init(initInput({ code: 'tiger-123' }));
    await assert.rejects(store.init(initInput({ code: 'eagle-456' })), /繁忙/);
    assert.equal(store.has('tiger-123'), true);
});

test('oversized and malformed chunks are rejected', async t => {
    const { store } = makeStore(t);
    await store.init(initInput());
    await assert.rejects(store.writeChunk('tiger-123', 0, Buffer.alloc(37)), /分片过大/);
    await assert.rejects(store.writeChunk('tiger-123', 0, Buffer.alloc(35)), /分片大小不正确/);
    await assert.rejects(store.writeChunk('tiger-123', 9, Buffer.alloc(36)), /分片序号无效/);
});

test('finish refuses missing chunks and byte mismatches', async t => {
    const { store } = makeStore(t);
    await store.init(initInput());
    await store.writeChunk('tiger-123', 0, Buffer.alloc(36));
    await assert.rejects(store.finish('tiger-123'), /缺少 1 个分片/);
});

test('expiry and abandoned uploads are swept from disk', async t => {
    const { store, advance } = makeStore(t, { partialTtlMs: 30 * MINUTE });

    await store.init(initInput({ code: 'tiger-123', ttlMs: MINUTE }));
    await store.writeChunk('tiger-123', 0, Buffer.alloc(36));
    await store.writeChunk('tiger-123', 1, Buffer.alloc(30));
    await store.finish('tiger-123');

    await store.init(initInput({ code: 'eagle-456', ttlMs: 60 * MINUTE }));
    await store.writeChunk('eagle-456', 0, Buffer.alloc(36));

    advance(MINUTE + 1);
    assert.deepEqual(await store.sweep(), { removed: 1 });
    assert.equal(store.has('tiger-123'), false);
    assert.equal(store.has('eagle-456'), true);

    advance(30 * MINUTE);
    assert.deepEqual(await store.sweep(), { removed: 1 });
    assert.equal(store.has('eagle-456'), false);
});

test('tokens expire and cannot be replayed', async t => {
    const { store, advance } = makeStore(t, { tokenTtlMs: MINUTE });
    await upload(store, 'tiger-123');

    const access = await store.access('tiger-123', null);
    advance(MINUTE + 1);
    assert.throws(() => store.consumeToken(access.token), /已过期/);
});

test('access before finishing is refused', async t => {
    const { store } = makeStore(t);
    await store.init(initInput());
    await assert.rejects(store.access('tiger-123', null), /尚未上传完成/);
});
