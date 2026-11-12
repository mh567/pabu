'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createIconHandler } = require('../lib/icon-http-handler');

const icon = {
    data: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082', 'hex'),
    contentType: 'image/png', etag: '"icon-etag"', source: 'html', validatedAt: 1794460000000, stale: false
};
const siteOrigin = 'https://icons.example';

async function serve(t, service) {
    const handler = createIconHandler(service, () => '192.0.2.20');
    const server = http.createServer((req, res) => {
        req.query = Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams);
        res.status = function (status) { this.statusCode = status; return this; };
        res.json = function (value) { this.setHeader('Content-Type', 'application/json; charset=utf-8'); this.end(JSON.stringify(value)); return this; };
        res.send = function (value) { this.end(value); return this; };
        Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
}

function service(overrides = {}) {
    return {
        refreshCooldownMs: 60000,
        canonicalOrigin: raw => raw.startsWith(siteOrigin) ? siteOrigin : null,
        checkRequestBudget: () => ({ allowed: true }),
        getIcon: async () => icon,
        refreshIcon: async () => ({ status: 'ok', icon }),
        ...overrides
    };
}

function iconUrl(base) { return `${base}/api/icon?url=${encodeURIComponent(`${siteOrigin}/bookmark?private=1`)}`; }

test('icon HTTP handler sends cache headers, honors fresh ETag, and keeps stale images at 200', async t => {
    let stale = false;
    const seen = [];
    const base = await serve(t, service({ getIcon: async origin => { seen.push(origin); return { ...icon, stale }; } }));
    const first = await fetch(iconUrl(base));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.equal(first.headers.get('cache-control'), 'private, max-age=86400');
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(first.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(first.headers.get('etag'), icon.etag);
    assert.equal(first.headers.get('x-pabu-icon-source'), 'html');
    assert.equal(first.headers.get('x-pabu-icon-validated-at'), new Date(icon.validatedAt).toISOString());
    assert.equal(first.headers.get('x-pabu-icon-stale'), 'false');
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), icon.data);

    const fresh304 = await fetch(iconUrl(base), { headers: { 'If-None-Match': icon.etag } });
    assert.equal(fresh304.status, 304);
    assert.equal(await fresh304.text(), '');

    stale = true;
    const staleImage = await fetch(iconUrl(base), { headers: { 'If-None-Match': icon.etag } });
    assert.equal(staleImage.status, 200);
    assert.equal(staleImage.headers.get('x-pabu-icon-stale'), 'true');
    assert.deepEqual(seen, [siteOrigin, siteOrigin, siteOrigin]);
});

test('icon HTTP handler maps refresh outcomes to retryable HTTP statuses', async t => {
    const outcomes = [
        [{ status: 'cooldown', retryAfterMs: 2000, icon }, 429, '2'],
        [{ status: 'timeout', icon }, 504, '5'],
        [{ status: 'failed', icon }, 502, '300'],
        [{ status: 'unavailable', icon }, 503, '1']
    ];
    for (const [outcome, status, retryAfter] of outcomes) {
        const base = await serve(t, service({ refreshIcon: async () => outcome }));
        const response = await fetch(`${iconUrl(base)}&refresh=1`);
        assert.equal(response.status, status);
        assert.equal(response.headers.get('retry-after'), retryAfter);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
});

test('icon HTTP handler stops waiting when the requesting client disconnects', async t => {
    let called;
    const started = new Promise(resolve => { called = resolve; });
    let requestSignal;
    let aborted;
    const signalAborted = new Promise(resolve => { aborted = resolve; });
    const base = await serve(t, service({ getIcon: (_origin, { signal }) => {
        requestSignal = signal;
        called();
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
            aborted();
            reject(Object.assign(new Error('closed'), { code: 'client_closed' }));
        }, { once: true }));
    } }));
    const request = http.get(iconUrl(base));
    request.on('error', () => {});
    await started;
    request.destroy();
    await Promise.race([signalAborted, new Promise((_, reject) => setTimeout(() => reject(new Error('handler did not abort the icon waiter')), 1000))]);
    assert.equal(requestSignal.aborted, true);
});
