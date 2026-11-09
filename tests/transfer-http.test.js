'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installation } = require('./helpers/installation');

// 8 字节明文分片，AES-GCM 信封 28 字节。10 字节文件正好两个分片。
const CHUNK_SIZE = 8;
const CHUNK_BYTES = 36;
const SIZE = 10;
const STORED_SIZE = 66;
const FIRST = Buffer.alloc(CHUNK_BYTES, 1);
const LAST = Buffer.alloc(SIZE - CHUNK_SIZE + 28, 2);

function putChunk(app, code, index, buffer) {
    return fetch(`${app.base}/api/file/${code}/chunk/${index}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Pabu-Request': '1',
            Origin: app.base
        },
        body: buffer
    });
}

test('HTTP relay transfer: upload, PIN gate, one download and deletion', async t => {
    const app = await installation(t, { env: { PABU_TRANSFER_CHUNK_SIZE: String(CHUNK_SIZE), PABU_TRANSFER_MAX_FILE: '1024' } });
    await app.start();

    const limits = await (await app.request('/api/file/limits')).json();
    assert.equal(limits.chunkSize, CHUNK_SIZE);
    assert.equal(limits.chunkBytes, CHUNK_BYTES);

    const { code } = await (await app.request('/api/file/code', { method: 'POST', body: {} })).json();
    assert.match(code, /^[a-z]{2,6}-\d{3}$/);

    const created = await app.request('/api/file/init', {
        body: {
            code,
            size: SIZE,
            storedSize: STORED_SIZE,
            chunkSize: CHUNK_SIZE,
            chunkBytes: CHUNK_BYTES,
            name: '说明.txt',
            type: 'text/plain',
            pin: '2468',
            ttl: 5
        }
    });
    assert.equal(created.status, 200);

    assert.equal((await putChunk(app, code, 0, FIRST)).status, 200);
    assert.equal((await putChunk(app, code, 1, LAST)).status, 200);
    assert.equal((await app.request(`/api/file/${code}/finish`, { body: {} })).status, 200);

    const meta = await (await app.request(`/api/file/${code}/meta`)).json();
    assert.equal(meta.exists, true);
    assert.equal(meta.hasPin, true);
    assert.equal(meta.uploading, false);

    const wrongPin = await app.request(`/api/file/${code}/access`, { body: { pin: '0000' } });
    assert.equal(wrongPin.status, 403);

    const accessResponse = await app.request(`/api/file/${code}/access`, { body: { pin: '2468' } });
    assert.equal(accessResponse.status, 200);
    const access = await accessResponse.json();
    assert.equal(access.name, '说明.txt');
    assert.equal(access.size, SIZE);
    assert.equal(access.chunkCount, 2);

    const redirect = await fetch(`${app.base}/p/${code}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), `/f/${code}`);

    const page = await fetch(`${app.base}/f/${code}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /下载并解密/);

    const download = await fetch(`${app.base}/api/file/${code}/download`, {
        headers: { 'X-Pabu-Grant': access.token }
    });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    const body = Buffer.from(await download.arrayBuffer());
    assert.equal(body.length, STORED_SIZE);
    assert.deepEqual(body.subarray(0, CHUNK_BYTES), FIRST);
    assert.deepEqual(body.subarray(CHUNK_BYTES), LAST);

    const replay = await fetch(`${app.base}/api/file/${code}/download`, {
        headers: { 'X-Pabu-Grant': access.token }
    });
    assert.equal(replay.status, 403);

    const after = await (await app.request(`/api/file/${code}/meta`)).json();
    assert.equal(after.exists, false);
});

test('HTTP relay transfer rejects oversized chunks and missing files', async t => {
    const app = await installation(t, { env: { PABU_TRANSFER_CHUNK_SIZE: String(CHUNK_SIZE), PABU_TRANSFER_MAX_FILE: '1024' } });
    await app.start();

    assert.equal((await app.request('/api/file/tiger-999/meta')).status, 200);
    assert.equal((await (await app.request('/api/file/tiger-999/meta')).json()).exists, false);

    const { code } = await (await app.request('/api/file/code', { method: 'POST', body: {} })).json();
    await app.request('/api/file/init', {
        body: {
            code,
            size: SIZE,
            storedSize: STORED_SIZE,
            chunkSize: CHUNK_SIZE,
            chunkBytes: CHUNK_BYTES,
            name: 'a.bin',
            type: 'application/octet-stream',
            ttl: 5
        }
    });

    const oversized = await putChunk(app, code, 0, Buffer.alloc(CHUNK_BYTES + 1));
    assert.equal(oversized.status, 413);

    const wrongType = await fetch(`${app.base}/api/file/${code}/chunk/0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', 'X-Pabu-Request': '1', Origin: app.base },
        body: Buffer.alloc(CHUNK_BYTES)
    });
    assert.equal(wrongType.status, 415);

    const unknown = await app.request('/api/file/eagle-999/finish', { body: {} });
    assert.equal(unknown.status, 404);
});
