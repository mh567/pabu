'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { IconService, extractIconLinks, detectContentType, isPublicAddress, createPinnedLookup } = require('../lib/icon-service');

const PUBLIC_DNS = async () => [{ address: '8.8.8.8', family: 4 }];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082', 'hex');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const TEST_CACHE_DIR = path.join(os.tmpdir(), `pabu-icon-test-${process.pid}`);
const services = [];
after(async () => {
    await Promise.all(services.flatMap(service => [...service.diskWrites]));
    await fs.rm(TEST_CACHE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
});
function response(url, body, type = 'image/png', statusCode = 200, extra = {}) {
    return { statusCode, headers: { 'content-type': type, ...extra }, body: Buffer.from(body), finalUrl: url };
}
function createService(options = {}) {
    const service = new IconService({ cacheDir: TEST_CACHE_DIR, legacyCacheFile: false, ...options });
    services.push(service);
    return service;
}

test('icon service: canonical origin removes URL details, rejects credentials and disallowed ports', () => {
    const service = createService();
    assert.equal(service.canonicalOrigin('https://example.com/private?q=secret#fragment'), 'https://example.com');
    assert.equal(service.validateUrl('https://user:pass@example.com/path'), null);
    assert.equal(service.validateUrl('https://@example.com/path'), null);
    assert.equal(service.validateUrl('https://:@example.com/path'), null);
    assert.equal(service.validateUrl('https://example.com:8443/'), null);
    assert.equal(service.validateUrl('https://example.com:80/'), null);
    assert.equal(service.validateUrl('ftp://example.com/'), null);
    assert.equal(service.validateUrl('http://private.localhost/'), null);
    assert.equal(service.validateUrl('http://host.internal/'), null);
});

test('icon service: reject reserved, private, local, link-local and metadata addresses', () => {
    for (const address of [
        '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
        '192.0.2.1', '192.168.1.2', '198.18.0.1', '203.0.113.2', '224.0.0.1', '240.0.0.1',
        '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2001::1', '2002::1', '3fff::1', '5f00::1'
    ]) assert.equal(isPublicAddress(address), false, `${address} must be rejected`);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
    assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
});

test('icon service: Node lookup callback always returns the checked address', async () => {
    const lookup = createPinnedLookup('8.8.8.8');
    assert.deepEqual(await new Promise((resolve, reject) => lookup('rebinding.test', {}, (error, address, family) => error ? reject(error) : resolve({ address, family }))), { address: '8.8.8.8', family: 4 });
    assert.deepEqual(await new Promise((resolve, reject) => lookup('rebinding.test', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))), [{ address: '8.8.8.8', family: 4 }]);
});

test('icon service: lookup rejects a mixed public and private DNS answer before request', async () => {
    let requests = 0;
    const service = createService({ lookup: async () => [
        { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }
    ], request: async () => { requests++; throw Error('must not request'); } });
    assert.equal(await service.getIcon('https://mixed.test'), null);
    assert.equal(requests, 0);
});

test('icon service: icon links are prioritized and bounded head metadata supports base href', () => {
    const html = '<head><base href="/assets/"><link rel="icon" href="normal.png"><link rel="apple-touch-icon" href="touch.png"><link rel="icon" href="logo.svg"></head>';
    assert.deepEqual(extractIconLinks(html), ['logo.svg', 'normal.png', 'touch.png']);
    assert.equal(detectContentType(PNG), 'image/png');
    assert.equal(detectContentType(SVG), 'image/svg+xml');
    assert.equal(detectContentType(Buffer.from('<html>no</html>')), null);
});

test('icon service: icon links decode HTML entities, prefer useful declarations, and cap candidates', () => {
    const html = '<head>' + [
        '<link rel="apple-touch-icon" href="/apple.png" sizes="180x180">',
        '<link rel="icon" href="/main.png?one=1&amp;two=2" sizes="64x64">',
        '<link rel="icon" href="/vector.svg" type="image/svg+xml">',
        ...Array.from({ length: 8 }, (_, index) => `<link rel="icon" href="/extra-${index}.png">`)
    ].join('') + '</head>';
    const links = extractIconLinks(html);
    assert.equal(links.length, 6);
    assert.equal(links[0], '/main.png?one=1&two=2');
    assert.equal(links[1], '/vector.svg');
    assert.ok(!links.includes('/extra-7.png'));
});

test('icon service: oversized HTML is truncated at 256 KiB while retaining head icon discovery', async () => {
    let iconRequested = false;
    let htmlLimit = 0;
    const service = createService({ lookup: PUBLIC_DNS, request: async (url, address, maxBytes) => {
        if (url.endsWith('/')) { htmlLimit = maxBytes; return response(url, `<head>${' '.repeat(255 * 1024)}<link rel="icon" href="/i.png"></head>${'x'.repeat(100 * 1024)}`, 'text/html'); }
        if (url.endsWith('/i.png')) { iconRequested = true; return response(url, PNG); }
        return response(url, '', '', 404);
    }});
    const icon = await service.getIcon('https://long-html.test');
    assert.ok(icon);
    assert.equal(iconRequested, true);
    assert.equal(htmlLimit, 256 * 1024);
});

test('icon service: per-request timeout is capped and reserves a final fallback window', async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    const calls = [];
    const service = createService({ fallbackProviders: 'google', lookup: PUBLIC_DNS, request: async (url, address, maxBytes, timeout) => {
        calls.push({ url, timeout });
        const startedAt = now;
        await Promise.resolve();
        now = Math.max(now, startedAt + timeout);
        if (url.endsWith('/')) return response(url, '<head></head>', 'text/html');
        if (url.includes('pabu-icon-missing.invalid')) return response(url, '', '', 404);
        if (url.includes('google.com/s2/favicons')) return response(url, PNG);
        return response(url, '', '', 404);
    }});
    try {
        const icon = await service.getIcon('https://budget.test');
        assert.ok(icon);
        assert.ok(calls.every(call => call.timeout <= 5000));
        assert.ok(calls.at(-1).url.includes('google.com/s2/favicons'));
        assert.ok(calls.at(-1).timeout >= 4000);
    } finally { Date.now = realNow; }
});

test('icon service: absolute per-request timeout aborts a slow response before the task budget', async () => {
    let aborted = 0;
    const service = createService({ jobBudgetMs: 800, requestTimeoutMs: 10, lookup: PUBLIC_DNS, request: async (url, address, maxBytes, timeout, signal) => {
        if (url.endsWith('/')) return response(url, '<head><link rel="icon" href="/slow.png"></head>', 'text/html');
        return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
    }});
    const started = Date.now();
    assert.equal(await service.getIcon('https://slow-response.test'), null);
    assert.ok(Date.now() - started < 200);
    assert.equal(aborted, 4);
});

test('icon service: provider not-found responses never become cached icons', async () => {
    const service = createService({ fallbackProviders: 'google,duckduckgo', lookup: PUBLIC_DNS, request: async url => {
        if (url.endsWith('/')) return response(url, '<head></head>', 'text/html');
        return response(url, PNG, 'image/png', 404);
    }});
    assert.equal(await service.getIcon('https://provider-missing.test'), null);
    assert.equal(service.cache.has('https://provider-missing.test'), false);
});

test('icon service: bounded legacy JSON cache migrates image bytes as stale records', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pabu-icon-migrate-'));
    const cacheDir = path.join(tempDir, 'icons');
    const legacyCacheFile = path.join(tempDir, '.icon-cache.json');
    const origin = 'https://legacy.test';
    await fs.writeFile(legacyCacheFile, JSON.stringify([[origin, {
        data: PNG.toString('base64'), contentType: 'image/png', timestamp: Date.now()
    }]]));
    const service = new IconService({ cacheDir, legacyCacheFile });
    try {
        await service._cleanDisk({ removeTemps: true });
        const migrated = await service._loadDisk(origin);
        assert.ok(migrated);
        assert.equal(migrated.data.toString('hex'), PNG.toString('hex'));
        assert.equal(migrated.validatedAt, 0);
        assert.equal(await fs.stat(legacyCacheFile).then(() => true, () => false), false);
    } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
});

test('icon service: canonical origin shares fetched icon and never uses bookmark path', async () => {
    const urls = [];
    const service = createService({ lookup: PUBLIC_DNS, request: async url => {
        urls.push(url);
        if (url === 'https://site.test/') return response(url, '<head><link rel="icon" href="/brand.png"></head>', 'text/html');
        if (url === 'https://site.test/brand.png') return response(url, PNG);
        return response(url, '', '', 404);
    }});
    const first = await service.getIcon('https://site.test/bookmark/path?q=private#x');
    const second = await service.getIcon('https://site.test/another/path');
    assert.equal(first.contentType, 'image/png');
    assert.equal(second.etag, first.etag);
    assert.deepEqual(urls, ['https://site.test/', 'https://site.test/brand.png']);
});

test('icon service: same-origin misses singleflight, and image bytes are streamed within size limit', async () => {
    let pageCalls = 0;
    let release;
    const service = createService({ lookup: PUBLIC_DNS, request: async (url, address, maxBytes) => {
        assert.equal(address, '8.8.8.8');
        if (url === 'https://one.test/') {
            pageCalls++;
            await new Promise(resolve => { release = resolve; });
            return response(url, '<head><link rel="icon" href="/i.png"></head>', 'text/html');
        }
        return response(url, PNG);
    }});
    const requests = [1, 2, 3].map(() => service.getIcon('https://one.test/page'));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(pageCalls, 1);
    release();
    assert.equal((await Promise.all(requests)).filter(Boolean).length, 3);
});

test('icon service: disconnected waiters release and cancel unused cold work only after the last leave', async () => {
    let requestStarted;
    let upstreamAborted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    const aborted = new Promise(resolve => { upstreamAborted = resolve; });
    const service = createService({ lookup: PUBLIC_DNS, request: async (url, address, maxBytes, timeout, signal) => new Promise((resolve, reject) => {
        requestStarted();
        signal.addEventListener('abort', () => { upstreamAborted(); reject(signal.reason); }, { once: true });
    }) });
    const first = new AbortController();
    const second = new AbortController();
    const a = service.getIcon('https://cancel-waiter.test', { signal: first.signal });
    const b = service.getIcon('https://cancel-waiter.test', { signal: second.signal });
    await started;
    first.abort();
    await assert.rejects(a, error => error.code === 'client_closed');
    assert.equal(service.waitingRequests, 1);
    second.abort();
    await assert.rejects(b, error => error.code === 'client_closed');
    await aborted;
    assert.equal(service.waitingRequests, 0);
    while (service.inFlight.has('https://cancel-waiter.test')) await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.inFlight.has('https://cancel-waiter.test'), false);
    assert.equal(service.negativeCache.has('https://cancel-waiter.test'), false);
});

test('icon service: stale response is immediate and same-content validation keeps ETag', async () => {
    let imageCalls = 0;
    let release;
    const service = createService({ ttlMs: 1, lookup: PUBLIC_DNS, request: async url => {
        if (url.endsWith('/')) return response(url, '<head><link rel="icon" href="/i.png"></head>', 'text/html');
        imageCalls++;
        if (imageCalls > 1) await new Promise(resolve => { release = resolve; });
        return response(url, PNG);
    }});
    const initial = await service.getIcon('https://stale.test');
    await new Promise(resolve => setTimeout(resolve, 5));
    const startedAt = Date.now();
    const stale = await service.getIcon('https://stale.test/path');
    assert.equal(stale.stale, true);
    assert.ok(Date.now() - startedAt < 100);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release();
    const job = service.inFlight.get('https://stale.test');
    if (job) await job.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(service.cache.get('https://stale.test').etag, initial.etag);
    assert.ok(service.cache.get('https://stale.test').validatedAt > initial.validatedAt);
});

test('icon service: refresh failure preserves prior image and negative cache stays separately bounded', async () => {
    let fail = false;
    const service = createService({ maxNegativeEntries: 1, lookup: PUBLIC_DNS, request: async url => {
        if (fail) return response(url, '', '', 503);
        if (url.endsWith('/')) return response(url, '<head><link rel="icon" href="/i.png"></head>', 'text/html');
        return response(url, PNG);
    }});
    const first = await service.getIcon('https://keep.test');
    fail = true;
    const result = await service.refreshIcon('https://keep.test', { waitMs: 200 });
    assert.equal(result.status, 'failed');
    assert.deepEqual(service.cache.get('https://keep.test').data, first.data);
    await Promise.all(['https://n1.test', 'https://n2.test'].map(origin => service.getIcon(origin)));
    assert.ok(service.negativeCache.size <= 1);
});

test('icon service: refresh timeout and cooldown are distinct and share the job', async () => {
    let releasePage;
    let releaseIcon;
    let iconStarted;
    const iconStartedPromise = new Promise(resolve => { iconStarted = resolve; });
    let calls = 0;
    const service = createService({ jobBudgetMs: 1000, lookup: PUBLIC_DNS, request: async url => {
        calls++;
        if (url.endsWith('/')) {
            await new Promise(resolve => { releasePage = resolve; });
            return response(url, '<head><link rel="icon" href="/i.png"></head>', 'text/html');
        }
        iconStarted();
        await new Promise(resolve => { releaseIcon = resolve; });
        return response(url, PNG);
    }});
    const timeout = await service.refreshIcon('https://slow.test', { waitMs: 5 });
    assert.equal(timeout.status, 'timeout');
    const joined = await service.refreshIcon('https://slow.test', { waitMs: 5 });
    assert.equal(joined.status, 'timeout');
    assert.equal(calls, 1);
    const job = service.inFlight.get('https://slow.test');
    releasePage();
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed-out refresh should keep the shared job running')), 100);
        iconStartedPromise.then(() => { clearTimeout(timer); resolve(); });
    });
    releaseIcon();
    await job.promise;
    const cooldown = await service.refreshIcon('https://slow.test', { waitMs: 5 });
    assert.equal(cooldown.status, 'cooldown');
    assert.equal(calls, 2);
});

test('icon service: overlapping manual refreshes join one active refresh task', async () => {
    let release;
    let started;
    let rootCalls = 0;
    const requestStarted = new Promise(resolve => { started = resolve; });
    const service = createService({ lookup: PUBLIC_DNS, request: async url => {
        if (url.endsWith('/')) {
            rootCalls++;
            started();
            await new Promise(resolve => { release = resolve; });
            return response(url, '<head><link rel="icon" href="/i.png"></head>', 'text/html');
        }
        return response(url, PNG);
    }});
    const first = service.refreshIcon('https://refresh-join.test', { waitMs: 1000 });
    await requestStarted;
    const second = service.refreshIcon('https://refresh-join.test', { waitMs: 1000 });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 'ok');
    assert.equal(b.status, 'ok');
    assert.equal(rootCalls, 1);
});

test('icon service: an already disconnected refresh does not start work or consume cooldown', async () => {
    let calls = 0;
    const service = createService({ lookup: PUBLIC_DNS, request: async () => { calls++; return response('https://unused.test/', PNG); } });
    const controller = new AbortController();
    controller.abort();
    assert.equal((await service.refreshIcon('https://cancel-refresh.test', { signal: controller.signal })).status, 'cancelled');
    assert.equal(calls, 0);
    assert.equal(service.lastRefresh.has('https://cancel-refresh.test'), false);
    assert.equal(service.inFlight.has('https://cancel-refresh.test'), false);
});

test('icon service: service-budget abort is reported as a refresh timeout', async () => {
    const service = createService({ jobBudgetMs: 10, lookup: PUBLIC_DNS, request: async (url, address, maxBytes, timeout, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const result = await service.refreshIcon('https://budget-timeout.test', { waitMs: 100 });
    assert.equal(result.status, 'timeout');
    assert.equal(service.negativeCache.has('https://budget-timeout.test'), false);
});

test('icon service: default shared-cache and anonymous work limits match the service contract', () => {
    const service = createService();
    assert.equal(service.maxEntries, 500);
    assert.equal(service.maxBytes, 32 * 1024 * 1024);
    assert.equal(service.maxDiskEntries, 1000);
    assert.equal(service.maxDiskBytes, 64 * 1024 * 1024);
    assert.equal(service.maxImageBytes, 2 * 1024 * 1024);
    assert.equal(service.maxNegativeEntries, 2000);
    assert.equal(service.maxActiveJobs, 8);
    assert.equal(service.maxQueuedOrigins, 64);
    assert.equal(service.maxOriginWaiters, 128);
    assert.equal(service.maxWaitingRequests, 512);
    assert.equal(service.jobBudgetMs, 20000);
    assert.equal(service.queueWaitMs, 3000);
    assert.equal(service.fallbackProviders.size, 0);
});

test('icon service: memory cache evicts least recently used records by count and bytes', () => {
    const service = createService({ maxEntries: 2, maxBytes: SVG.length * 2 });
    const item = () => ({ data: SVG, contentType: 'image/svg+xml', validatedAt: Date.now(), etag: '"x"' });
    service._setCache('https://a.test', item());
    service._setCache('https://b.test', item());
    service._touch('https://a.test', service.cache.get('https://a.test'));
    service._setCache('https://c.test', item());
    assert.deepEqual([...service.cache.keys()], ['https://a.test', 'https://c.test']);
    assert.equal(service.cacheBytes, SVG.length * 2);
});

test('icon service: upstream Retry-After extends shared origin backoff', async () => {
    let calls = 0;
    const service = createService({ lookup: PUBLIC_DNS, request: async url => {
        calls++;
        return response(url, '', '', 503, { 'retry-after': '120' });
    }});
    assert.equal(await service.getIcon('https://backoff.test'), null);
    const until = service.negativeCache.get('https://backoff.test').nextRetryAt;
    assert.ok(until >= Date.now() + 119000);
    assert.equal((await service.refreshIcon('https://backoff.test')).status, 'cooldown');
    assert.equal(calls, 1, 'manual refresh cannot bypass origin backoff');
});

test('icon service: shared origin failures back off from five minutes to one day', () => {
    const service = createService({ random: () => 0.5 });
    let now = 1000;
    const delays = [];
    for (let index = 0; index < 4; index++) {
        service._setNegative('https://failure.test', 0, now);
        const failure = service.negativeCache.get('https://failure.test');
        delays.push(failure.nextRetryAt - now);
        now = failure.nextRetryAt + 1;
    }
    assert.deepEqual(delays, [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
});

test('icon service: disk uses one hashed record per origin and corrupt files do not break reads', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pabu-icons-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    let calls = 0;
    const request = async url => {
        calls++;
        if (url.endsWith('/')) return response(url, '<head><link rel="icon" href="/i.png"></head>', 'text/html');
        return response(url, PNG);
    };
    const options = { cacheDir: dir, lookup: PUBLIC_DNS, request };
    const writer = new IconService(options);
    await writer.getIcon('https://disk.test');
    await Promise.all([...writer.diskWrites]);
    for (let i = 0; i < 50 && !(await fs.readdir(dir)).some(name => /^[a-f0-9]{64}\.json$/.test(name)); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const files = await fs.readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    await fs.writeFile(path.join(dir, 'bad.json'), '{broken');
    const restored = await new IconService(options).getIcon('https://disk.test/path');
    assert.ok(restored);
    assert.equal(calls, 2, 'lazy disk lookup avoids refetch');
});

test('icon service: stale disk image is returned while shared revalidation continues', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pabu-icon-stale-disk-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const origin = 'https://stale-disk.test';
    const filename = `${require('node:crypto').createHash('sha256').update(origin).digest('hex')}.json`;
    await fs.writeFile(path.join(dir, filename), JSON.stringify({ origin, validatedAt: Date.now() - 10000, contentType: 'image/png', etag: 'old-etag', data: PNG.toString('base64') }));
    let release;
    const service = createService({ cacheDir: dir, ttlMs: 1, lookup: PUBLIC_DNS, request: async url => {
        if (url.endsWith('/')) return response(url, '<head><link rel="icon" href="/i.png"></head>', 'text/html');
        await new Promise(resolve => { release = resolve; });
        return response(url, PNG);
    }});
    const stale = await service.getIcon(origin);
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.data, PNG);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release();
    const job = service.inFlight.get(origin);
    if (job) await job.promise;
    await Promise.all([...service.diskWrites]);
});

test('icon service: disk cleanup enforces both record-count and byte bounds', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pabu-icon-clean-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new IconService({ cacheDir: dir, maxDiskEntries: 2, maxDiskBytes: 1024 });
    for (const name of ['a', 'b', 'c']) await fs.writeFile(path.join(dir, `${name.repeat(64)}.json`), 'x');
    await service._cleanDisk();
    assert.ok((await fs.readdir(dir)).length <= 2);
    const tiny = new IconService({ cacheDir: dir, maxDiskEntries: 9, maxDiskBytes: 0 });
    await tiny._cleanDisk();
    assert.equal((await fs.readdir(dir)).length, 0);
});

test('icon service: oversized malformed disk records are skipped before reading JSON', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pabu-icon-large-disk-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const origin = 'https://oversized-record.test';
    const filename = `${require('node:crypto').createHash('sha256').update(origin).digest('hex')}.json`;
    await fs.writeFile(path.join(dir, filename), Buffer.alloc(4 * 1024 * 1024, 0x20));
    let fetched = false;
    const service = createService({ cacheDir: dir, lookup: PUBLIC_DNS, request: async url => {
        fetched = true;
        if (url.endsWith('/')) return response(url, '<head><link rel="icon" href="/i.png"></head>', 'text/html');
        return response(url, PNG);
    }});
    assert.ok(await service.getIcon(origin));
    await Promise.all([...service.diskWrites]);
    assert.equal(fetched, true);
});

test('icon service: manifest, relative redirect and data images are handled safely', async () => {
    const urls = [];
    const service = createService({ lookup: PUBLIC_DNS, request: async url => {
        urls.push(url);
        if (url === 'https://manifest.test/') return response(url, '<head><base href="/site/"><link rel="manifest" href="manifest.json"></head>', 'text/html');
        if (url === 'https://manifest.test/site/manifest.json') return response(url, JSON.stringify({ icons: [{ src: 'assets/icon.png' }] }), 'application/manifest+json');
        if (url === 'https://manifest.test/site/assets/icon.png') return { statusCode: 302, headers: { location: '../real.png' }, location: '../real.png', body: Buffer.alloc(0), finalUrl: url };
        if (url === 'https://manifest.test/site/real.png') return response(url, PNG);
        return response(url, '', '', 404);
    }});
    const result = await service.getIcon('https://manifest.test');
    assert.equal(result.contentType, 'image/png');
    assert.ok(urls.includes('https://manifest.test/site/real.png'));
    assert.equal(detectContentType(Buffer.from('<html>')) , null);
});

test('icon service: valid bounded data:image icons are accepted without network fetch', async () => {
    let calls = 0;
    const encoded = PNG.toString('base64');
    const service = createService({ lookup: PUBLIC_DNS, request: async url => {
        calls++;
        return response(url, `<head><link rel="icon" href="data:image/png;base64,${encoded}"></head>`, 'text/html');
    }});
    const image = await service.getIcon('https://data-image.test');
    assert.deepEqual(image.data, PNG);
    assert.equal(calls, 1);
});

test('icon service: percent-encoded data SVG icons are decoded within the image limit', async () => {
    const encoded = encodeURIComponent(SVG.toString());
    const service = createService({ lookup: PUBLIC_DNS, request: async url => response(url, `<head><link rel="icon" href="data:image/svg+xml,${encoded}"></head>`, 'text/html') });
    const image = await service.getIcon('https://encoded-data-image.test');
    assert.deepEqual(image.data, SVG);
    assert.equal(image.contentType, 'image/svg+xml');
});

test('icon service: 503 without Retry-After stops candidate retries and uses default backoff', async () => {
    let calls = 0;
    const service = createService({ lookup: PUBLIC_DNS, request: async url => {
        calls++;
        return response(url, '', '', 503);
    }});
    assert.equal(await service.getIcon('https://upstream-busy.test'), null);
    assert.equal(calls, 1);
    assert.ok(service.negativeCache.get('https://upstream-busy.test').nextRetryAt > Date.now());
});

test('icon service: oversized response bodies and HTML disguised as an image are rejected', async () => {
    const service = createService({ maxImageBytes: 8, lookup: PUBLIC_DNS, request: async url => {
        if (url.endsWith('/')) return response(url, '<head><link rel="icon" href="/fake.png"></head>', 'text/html');
        return response(url, '<html>masquerading</html>', 'image/png');
    }});
    assert.equal(await service.getIcon('https://invalid-image.test'), null);
});

test('icon service: a truncated PNG signature is rejected and never enters the shared cache', async () => {
    const invalidPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const service = createService({ lookup: PUBLIC_DNS, request: async url => {
        if (url.endsWith('/')) return response(url, '<head><link rel="icon" href="/truncated.png"></head>', 'text/html');
        if (url.endsWith('/truncated.png')) return response(url, invalidPng);
        return response(url, '', '', 404);
    }});
    assert.equal(await service.getIcon('https://truncated-png.test'), null);
    assert.equal(service.cache.has('https://truncated-png.test'), false);
    assert.equal(service.negativeCache.has('https://truncated-png.test'), true);
});

test('icon service: PNG chunk corruption is rejected before it can be cached', () => {
    const damaged = Buffer.from(PNG);
    damaged[50] ^= 1;
    const service = createService();
    assert.ok(service._imageFromResponse({ statusCode: 200, body: PNG }));
    assert.equal(service._imageFromResponse({ statusCode: 200, body: damaged }), null);
});

test('icon service: every redirect destination is re-resolved and checked', async () => {
    const requested = [];
    const service = createService({ lookup: async host => [{ address: host === 'private-hop.test' ? '10.0.0.1' : '8.8.8.8', family: 4 }], request: async url => {
        requested.push(url);
        if (url === 'https://redirect-check.test/') return { statusCode: 302, headers: { location: 'https://private-hop.test/' }, location: 'https://private-hop.test/', body: Buffer.alloc(0), finalUrl: url };
        return response(url, '', '', 404);
    }});
    assert.equal(await service.getIcon('https://redirect-check.test'), null);
    assert.ok(!requested.some(url => url.includes('private-hop.test')));
});

test('icon service: third-party fallback is opt-in and sends only canonical origin', async () => {
    const urls = [];
    const service = createService({ fallbackProviders: 'duckduckgo', lookup: PUBLIC_DNS, request: async url => {
        urls.push(url);
        if (url.startsWith('https://provider.test/')) return response(url, '', '', 404);
        if (url.includes('pabu-icon-missing.invalid')) return response(url, '', '', 404);
        return response(url, PNG);
    }});
    const result = await service.getIcon('https://provider.test/bookmark?secret=yes');
    assert.ok(result);
    const providerRequest = urls.find(url => url.includes('duckduckgo.com'));
    assert.equal(providerRequest, 'https://icons.duckduckgo.com/ip3/provider.test.ico');
    assert.ok(urls.every(url => !url.includes('secret')));
});

test('icon service: a provider image matching the missing-origin sentinel is rejected', async () => {
    const urls = [];
    const service = createService({ fallbackProviders: 'google', lookup: PUBLIC_DNS, request: async url => {
        urls.push(url);
        if (url.includes('google.com/s2/favicons')) return response(url, PNG);
        return response(url, '', '', 404);
    }});
    assert.equal(await service.getIcon('https://generic-provider.test'), null);
    assert.equal(service.cache.has('https://generic-provider.test'), false);
    assert.ok(urls.some(url => new URL(url).searchParams.get('domain_url') === 'https://pabu-icon-missing.invalid'));
});

test('icon service: per-origin waiters and separate per-IP request budgets are bounded', async () => {
    const service = createService({ maxOriginWaiters: 1, maxWaitingRequests: 2, lookup: PUBLIC_DNS, request: async url => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return response(url, '', '', 404);
    }});
    assert.equal(service.checkRequestBudget('ip', 'https://a.test').allowed, true);
    for (let i = 0; i < 100; i++) assert.equal(service.checkRequestBudget('repeat', 'https://same-origin.test').allowed, true);
    for (let i = 0; i < 60; i++) assert.equal(service.checkRequestBudget('new', `https://n${i}.test`).allowed, true);
    assert.equal(service.checkRequestBudget('new', 'https://n60.test').status, 429);
    const cached = createService();
    cached._setCache('https://cached.test', { data: PNG, contentType: 'image/png', validatedAt: Date.now(), etag: '"cached"' });
    for (let i = 0; i < 600; i++) assert.equal(cached.checkRequestBudget('same-ip', 'https://cached.test').allowed, true);
    assert.equal(cached.checkRequestBudget('same-ip', 'https://cached.test').status, 429);
    const a = service.getIcon('https://wait.test');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(service.getIcon('https://wait.test'), /waiter limit/);
    await a;
});

test('icon service: active jobs and queued origins have independent global caps', async () => {
    let release;
    let activeCalls = 0;
    const service = createService({ maxActiveJobs: 1, maxQueuedOrigins: 1, lookup: PUBLIC_DNS, request: async url => {
        activeCalls++;
        if (url === 'https://active.test/') await new Promise(resolve => { release = resolve; });
        return response(url, '', '', 404);
    }});
    const first = service.getIcon('https://active.test');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const second = service.getIcon('https://queued.test');
    await assert.rejects(service.getIcon('https://overflow.test'), /queue is full/);
    assert.equal(service.activeJobs, 1);
    assert.equal(service.queue.length, 1);
    release();
    await Promise.all([first, second]);
    assert.ok(activeCalls >= 2);
});

test('icon service: queued origin work expires within the configured queue wait', async () => {
    let release;
    const service = createService({ maxActiveJobs: 1, maxQueuedOrigins: 1, queueWaitMs: 10, lookup: PUBLIC_DNS, request: async url => {
        if (url === 'https://queue-active.test/') await new Promise(resolve => { release = resolve; });
        return response(url, '', '', 404);
    }});
    const active = service.getIcon('https://queue-active.test');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(service.getIcon('https://queue-expire.test'), error => error.code === 'queue_timeout');
    assert.equal(service.inFlight.has('https://queue-expire.test'), false);
    release();
    await active;
});

test('icon service: reads bounded 403 challenge HTML and extracts its declared icon', async () => {
    const service = createService({ lookup: PUBLIC_DNS, request: async url => {
        if (url === 'https://challenge.test/') return response(url, '<head><link rel="icon" href="/brand.svg"></head>', 'text/html', 403);
        if (url === 'https://challenge.test/brand.svg') return response(url, SVG, 'image/svg+xml');
        return response(url, '', '', 404);
    }});
    const icon = await service.getIcon('https://challenge.test/private');
    assert.ok(icon, 'a bounded icon declaration on a 403 page remains usable');
    assert.equal(icon.contentType, 'image/svg+xml');
});

test('icon service: uses the approved refresh cooldown and per-request response header budget', async () => {
    const service = createService();
    assert.equal(service.refreshCooldownMs, 60000);
    const source = await fs.readFile(path.join(__dirname, '../lib/icon-service.js'), 'utf8');
    assert.match(source, /maxHeaderSize:\s*RESPONSE_HEADER_LIMIT/);
    assert.match(source, /new http\.Agent\(\{[^}]*keepAlive:\s*true/s);
    assert.match(source, /new https\.Agent\(\{[^}]*keepAlive:\s*true/s);
    assert.match(source, /agent:\s*parsed\.protocol\s*===\s*'https:'\s*\?\s*HTTPS_AGENT\s*:\s*HTTP_AGENT/);
});

test('icon service route: isolates fetched SVG and marks all retryable responses', async () => {
    const source = await fs.readFile(path.join(__dirname, '../lib/icon-http-handler.js'), 'utf8');
    const begin = source.indexOf('function createIconHandler');
    assert.ok(begin >= 0);
    const route = source.slice(begin);
    assert.match(route, /Content-Security-Policy/);
    assert.match(route, /sandbox/);
    assert.match(route, /X-Pabu-Icon-Source/);
    assert.match(route, /res\.once\('close', abortIfClosed\)/);
    assert.match(route, /getIcon\(origin, \{ signal: controller\.signal \}\)/);
    assert.match(route, /Cache-Control',\s*'private, max-age=86400/);
    assert.match(route, /Retry-After/);
    assert.match(route, /iconNotModified/);
});
