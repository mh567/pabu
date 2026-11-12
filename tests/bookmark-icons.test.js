'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const schema = require('../public/navigation-schema');

const read = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const has = (source, pattern, message) => assert.ok(pattern.test(source), message);
const config = iconUrl => ({
    theme: 'auto', showBookmarkIcons: true, searchEngine: 'one',
    searchEngines: [{ id: 'one', name: 'Search', url: 'https://example.com/?q=' }],
    categories: [{ id: 'cat', name: 'Work', bookmarks: [{ id: 'bm', title: 'Example', url: 'https://example.com/', ...(iconUrl === undefined ? {} : { iconUrl }) }] }]
});
const iconModule = () => require('../public/bookmark-icons');
async function withGlobals(values, run) {
    const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    try { return await run(); }
    finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

test('bookmark icons: optional custom URL survives schema projection and validates HTTP(S) without credentials', () => {
    const value = config('https://cdn.example/icon.png');
    assert.equal(schema.validate(value), value);
    assert.equal(schema.publicConfig(value).categories[0].bookmarks[0].iconUrl, 'https://cdn.example/icon.png');
    for (const url of ['javascript:alert(1)', 'https://user:pass@example.com/icon.png', 'https://example.com/icon.png#private', 'https://x/'.padEnd(2050, 'a')]) {
        assert.throws(() => schema.validate(config(url)));
    }
});

test('bookmark icons: client uses a persistent isolated cache and bounded cancellable loading', () => {
    const app = read('app.js');
    const icons = read('bookmark-icons.js');
    has(icons, /pabu-bookmark-icons-v1/, 'uses the dedicated persistent icon cache');
    has(icons, /cache:\s*['"]no-store['"]/, 'fetches server icons without browser HTTP cache');
    has(icons, /If-None-Match/, 'sends the cached validator');
    has(icons, /IntersectionObserver/, 'loads icons only near the visible grid');
    has(icons, /AbortController/, 'cancels work when it is no longer needed');
    has(icons, /25_?000/, 'caps API work at 25 seconds');
    has(icons, /8_?000/, 'caps internal candidate sequence at 8 seconds');
    has(icons, /3_?000/, 'caps a direct image candidate at 3 seconds');
    has(icons, /favicon\.ico/, 'tries internal favicon.ico');
    has(icons, /favicon\.png/, 'tries internal favicon.png');
    has(icons, /apple-touch-icon\.png/, 'tries internal apple touch icon');
    has(app, /data-icon-url/, 'keeps custom image address on direct browser path');
    assert.ok(!/encodeURIComponent\(bm\.iconUrl\)/.test(icons), 'custom image address is never sent through the server');
});

test('bookmark icons: editing and settings expose custom address, refresh, and local cache clearing', () => {
    const app = read('app.js');
    const html = read('index.html');
    has(app, /自定义图标地址/, 'bookmark editor contains the custom icon field');
    has(app, /刷新图标/, 'bookmark editor has a refresh action');
    has(html, /localClearIconCacheBtn/, 'settings contains local cache clearing control');
    has(app, /localClearIconCacheBtn/, 'clear action is connected');
});

test('bookmark icons: service worker upgrades preserve the dedicated icon cache', () => {
    const sw = read('sw.js');
    has(sw, /pabu-bookmark-icons-v1/, 'activation cleanup preserves dedicated icon cache');
    has(sw, /const CACHE = 'pabu-v32'/, 'new icon module is installed through a new static cache version');
});

test('bookmark icons: cache and request coordination live in a shared client module', () => {
    const methods = iconModule();
    assert.equal(typeof methods.initBookmarkIcons, 'function');
    assert.equal(typeof methods.fetchBookmarkIcon, 'function');
});

test('bookmark icons: App copies non-enumerable module methods before startup', () => {
    const methods = iconModule();
    const app = read('app.js');
    assert.equal(Object.prototype.propertyIsEnumerable.call(methods, 'initBookmarkIcons'), false);
    has(app, /Object\.getOwnPropertyDescriptors\(window\.BookmarkIconMethods\)/, 'copies class prototype descriptors');
    const descriptors = Object.getOwnPropertyDescriptors(methods);
    delete descriptors.constructor;
    const prototype = {};
    Object.defineProperties(prototype, descriptors);
    assert.equal(typeof prototype.initBookmarkIcons, 'function');
});

test('bookmark icons: visible-area observer can measure icons before they load', () => {
    const app = read('app.js');
    has(app, /data-icon-state="idle" style="visibility:hidden"/, 'keeps the unloaded image box measurable without flashing it');
});

test('bookmark icons: local and reserved hosts bypass the server icon endpoint', () => {
    const app = read('bookmark-icons.js');
    const begin = app.indexOf('        bookmarkIconIsPrivate(url) {');
    const end = app.indexOf('\n        bookmarkIconImage(', begin);
    assert.ok(begin >= 0 && end > begin);
    const classify = vm.runInNewContext(`({${app.slice(begin, end)}}).bookmarkIconIsPrivate`);
    for (const address of ['http://router.home.', 'http://router.local', 'http://192.168.1.1', 'http://100.100.2.3', 'http://203.0.113.4', 'http://[::]', 'http://[fd00::1]']) {
        assert.equal(classify(new URL(address)), true, `${address} is loaded directly by the browser`);
    }
    assert.equal(classify(new URL('https://example.com')), false);
});

test('bookmark icons: normal and manual refresh use the same origin key', async () => {
    const methods = iconModule();
    const app = Object.create(methods);
    let refreshTask;
    app.bookmarkIconCacheEpoch = 0;
    app.bookmarkIconIsPrivate = () => false;
    app.bookmarkIconController = () => new AbortController();
    app.withBookmarkIconTimeout = (_task, run) => run();
    app.fetchBookmarkIcon = async task => { refreshTask = task; return { blob: new Blob(['x']) }; };
    await app.refreshBookmarkIcon({ url: 'https://example.test/path' });
    assert.equal(refreshTask.key, 'auto:https://example.test');
});

test('bookmark icons: offline visible entries still enter the cache-reading queue', () => {
    const methods = iconModule();
    const app = Object.create(methods);
    let started = false;
    app.bookmarkIconTasks = new Map();
    app.bookmarkIconImageTasks = new WeakMap();
    app.bookmarkIconQueue = [];
    app.bookmarkIconCacheEpoch = 0;
    app.bookmarkIconActive = 0;
    app.bookmarkIconController = () => new AbortController();
    app.runBookmarkIconTask = async task => { started = true; clearTimeout(task.timeout); app.bookmarkIconActive--; };
    app.fillBookmarkIconQueue = () => {};
    return withGlobals({
        navigator: { onLine: false },
        document: { hidden: false }
    }, () => {
        const img = { isConnected: true, dataset: { iconMode: 'auto', bookmarkUrl: 'https://example.test/', iconState: 'idle' } };
        app.queueBookmarkIcon(img, 1);
        assert.equal(started, true);
    });
});

test('bookmark icons: API fetch carries its abort signal and manual refresh uses the same key', async () => {
    const methods = iconModule();
    const app = Object.create(methods);
    const controller = app.bookmarkIconController();
    let options;
    const writes = [];
    app.bookmarkIconMemory = new Map();
    app.bookmarkIconHash = async () => null;
    app.readBookmarkIcon = async () => null;
    app.writeBookmarkIcon = async (key, record) => writes.push({ key, record });
    app.withBookmarkIconLock = (_hash, _signal, run) => run();
    const task = { key: 'auto:https://example.test', url: new URL('https://example.test/path'), controller, epoch: 0 };
    await withGlobals({
        navigator: { onLine: true },
        location: { origin: 'https://pabu.test' },
        fetch: async (_url, value) => {
            options = value;
            return {
                ok: true, status: 200, type: 'basic',
                headers: { get: name => ({ 'content-type': 'image/png', etag: '"test"', 'x-pabu-icon-source': 'html', 'x-pabu-icon-validated-at': new Date().toISOString() })[name.toLowerCase()] || null },
                body: new Blob([new Uint8Array([1, 2, 3])]).stream()
            };
        }
    }, async () => {
        app.validateBookmarkIconBlob = async () => {};
        await app.fetchBookmarkIcon(task, { refresh: true });
    });
    assert.equal(options.signal, controller.signal);
    assert.equal(writes[0].key, task.key);
    assert.equal(writes[0].record.source, 'html');
});

test('bookmark icons: a failed lock fallback does not retry the icon request', async () => {
    const methods = iconModule();
    const app = Object.create(methods);
    let calls = 0;
    let value = null;
    await withGlobals({
        navigator: {},
        localStorage: {
            getItem() { return value; },
            setItem(_key, next) { value = next; },
            removeItem() { value = null; }
        }
    }, async () => {
        await assert.rejects(app.withBookmarkIconLock('hash', new AbortController().signal, async () => {
            calls++;
            throw new Error('network failed');
        }), /network failed/);
    });
    assert.equal(calls, 1);
});

test('bookmark icons: invalid image decoding never reaches cache storage', async () => {
    const methods = iconModule();
    const app = Object.create(methods);
    const controller = new AbortController();
    let writes = 0;
    app.bookmarkIconMemory = new Map();
    app.bookmarkIconHash = async () => null;
    app.readBookmarkIcon = async () => null;
    app.writeBookmarkIcon = async () => { writes++; };
    app.withBookmarkIconLock = (_hash, _signal, run) => run();
    app.validateBookmarkIconBlob = async () => { throw new Error('image decode failed'); };
    const task = { key: 'auto:https://bad-image.test', url: new URL('https://bad-image.test'), controller, epoch: 0 };
    await withGlobals({
        navigator: { onLine: true },
        location: { origin: 'https://pabu.test' },
        fetch: async () => ({
            ok: true, status: 200, type: 'basic',
            headers: { get: name => name.toLowerCase() === 'content-type' ? 'image/png' : null },
            body: new Blob([new Uint8Array([1, 2, 3])]).stream()
        })
    }, async () => assert.rejects(app.fetchBookmarkIcon(task), /image decode failed/));
    assert.equal(writes, 0);
});

test('bookmark icons: same-origin custom images stop streaming at 2 MiB and omit credentials', async () => {
    const app = Object.create(iconModule());
    const task = { key: 'custom:https://pabu.test/icon.png', url: new URL('https://pabu.test/icon.png'), mode: 'custom', controller: app.bookmarkIconController(), epoch: 0 };
    let options;
    let reads = 0;
    let cancelled = 0;
    const body = { getReader: () => ({
        async read() { reads++; return { done: false, value: new Uint8Array(reads === 1 ? 1024 * 1024 : 1024 * 1024 + 1) }; },
        async cancel() { cancelled++; },
        releaseLock() {}
    }) };
    app.readBookmarkIcon = async () => null;
    app.loadBookmarkImage = async () => { throw new Error('oversized icon must not fall back to an unbounded image load'); };
    await withGlobals({
        navigator: { onLine: true },
        location: { origin: 'https://pabu.test' },
        fetch: async (_url, value) => {
            options = value;
            return { ok: true, type: 'basic', body, headers: { get: name => name.toLowerCase() === 'content-type' ? 'image/png' : null }, arrayBuffer: async () => { throw new Error('arrayBuffer must not be used'); } };
        }
    }, async () => assert.rejects(app.loadDirectBookmarkIcon(task), /图标文件过大/));
    assert.equal(options.credentials, 'omit');
    assert.equal(reads, 2);
    assert.equal(cancelled, 1);
});

test('bookmark icons: a 304 without a local image retries once without its validator', async () => {
    const methods = iconModule();
    const app = Object.create(methods);
    const task = { key: 'auto:https://empty-cache.test', url: new URL('https://empty-cache.test'), controller: app.bookmarkIconController(), epoch: 0 };
    const requests = [];
    const writes = [];
    app.bookmarkIconHash = async () => null;
    app.readBookmarkIcon = async () => ({ etag: '"cached"' });
    app.writeBookmarkIcon = async (_key, record) => writes.push(record);
    app.withBookmarkIconLock = (_hash, _signal, run) => run();
    app.validateBookmarkIconBlob = async () => {};
    await withGlobals({
        navigator: { onLine: true },
        location: { origin: 'https://pabu.test' },
        fetch: async (_url, options) => {
            requests.push(options.headers['If-None-Match']);
            if (requests.length === 1) return { ok: false, status: 304, type: 'basic', headers: { get: () => null } };
            return {
                ok: true, status: 200, type: 'basic',
                headers: { get: name => name.toLowerCase() === 'content-type' ? 'image/png' : null },
                body: new Blob([new Uint8Array([1, 2, 3])]).stream()
            };
        }
    }, async () => app.fetchBookmarkIcon(task));
    assert.deepEqual(requests, ['"cached"', undefined]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].blob.type, 'image/png');
});

test('bookmark icons: aborting a task cancels its in-flight API fetch', async () => {
    const app = Object.create(iconModule());
    const controller = app.bookmarkIconController();
    const task = { key: 'auto:https://cancel.test', url: new URL('https://cancel.test'), controller, epoch: 0 };
    app.bookmarkIconHash = async () => null;
    app.readBookmarkIcon = async () => null;
    app.withBookmarkIconLock = (_hash, _signal, run) => run();
    let requested;
    const pending = withGlobals({
        navigator: { onLine: true },
        location: { origin: 'https://pabu.test' },
        fetch: (_url, options) => new Promise((_resolve, reject) => {
            requested = options.signal;
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        })
    }, () => app.fetchBookmarkIcon(task));
    while (!requested) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('bookmark icons: 429 and 503 obey Retry-After without counting a content failure', async () => {
    const methods = iconModule();
    const app = Object.create(methods);
    const task = { key: 'auto:https://busy.test', url: new URL('https://busy.test'), mode: 'auto', controller: app.bookmarkIconController(), epoch: 0, images: new Set(), deadline: Date.now() + 25000 };
    let stored;
    app.bookmarkIconHash = async () => null;
    app.readBookmarkIcon = async () => null;
    app.writeBookmarkIcon = async (_key, record) => { stored = record; };
    app.withBookmarkIconLock = (_hash, _signal, run) => run();
    app.bookmarkIconTasks = new Map([[task.key, task]]);
    app.bookmarkIconActive = 1;
    app.bookmarkIconQueue = [];
    app.fillBookmarkIconQueue = () => {};
    app.pumpBookmarkIcons = () => {};
    app.bookmarkIconCacheEpoch = 0;
    app.bookmarkIconImageTasks = new WeakMap();
    const before = Date.now();
    await withGlobals({
        navigator: { onLine: true },
        location: { origin: 'https://pabu.test' },
        fetch: async () => ({ ok: false, status: 503, type: 'basic', headers: { get: name => name.toLowerCase() === 'retry-after' ? '4' : null } })
    }, () => app.runBookmarkIconTask(task));
    assert.ok(stored.nextRetryAt >= before + 3900 && stored.nextRetryAt <= before + 4100, `retry delay was ${stored.nextRetryAt - before}ms`);
    assert.equal(stored.failureCount, 0);
    assert.equal(stored.nextCheckAt, stored.nextRetryAt);
});

test('bookmark icons: in-memory records obey entry and byte limits with LRU eviction', async () => {
    const app = Object.create(iconModule());
    app.bookmarkIconMemory = new Map();
    app.bookmarkIconMemoryBytes = 0;
    const blob = new Blob([new Uint8Array(2 * 1024 * 1024)]);
    for (let i = 0; i < 17; i++) app.rememberBookmarkIcon(`key:${i}`, { blob, lastUsedAt: i });
    assert.equal(app.bookmarkIconMemory.size, 16);
    assert.equal(app.bookmarkIconMemory.has('key:0'), false);
    assert.equal(app.bookmarkIconMemoryBytes, 32 * 1024 * 1024);
    const countLimited = Object.create(iconModule());
    countLimited.bookmarkIconMemory = new Map();
    countLimited.bookmarkIconMemoryBytes = 0;
    for (let i = 0; i < 500; i++) countLimited.rememberBookmarkIcon(`item:${i}`, { blob: null });
    await withGlobals({ window: {} }, () => countLimited.readBookmarkIcon('item:0'));
    countLimited.rememberBookmarkIcon('item:new', { blob: null });
    assert.equal(countLimited.bookmarkIconMemory.has('item:0'), true);
    assert.equal(countLimited.bookmarkIconMemory.has('item:1'), false);
    assert.equal(countLimited.bookmarkIconMemory.has('item:new'), true);
});

test('bookmark icons: persistent cache trims old metadata entries over its entry limit', async () => {
    const app = Object.create(iconModule());
    const records = new Map();
    const keyOf = value => typeof value === 'string' ? value : value.url;
    const cache = {
        async keys() { return [...records.keys()].map(url => new Request(url)); },
        async match(key) { return records.get(keyOf(key))?.clone(); },
        async put(key, response) { records.set(keyOf(key), response.clone()); },
        async delete(key) { return records.delete(keyOf(key)); }
    };
    for (let i = 0; i < 501; i++) {
        const key = `https://pabu.test/__pabu_bookmark_icon_cache__/${i}/meta`;
        await cache.put(new Request(key), new Response(JSON.stringify({ lastUsedAt: i })));
    }
    await app.trimBookmarkIconCache(cache);
    assert.equal((await cache.keys()).length, 500);
    assert.equal(await cache.match('https://pabu.test/__pabu_bookmark_icon_cache__/0/meta'), undefined);
    assert.ok(await cache.match('https://pabu.test/__pabu_bookmark_icon_cache__/500/meta'));
});

test('bookmark icons: persistent cache enforces its byte limit and expires old failures', async () => {
    const app = Object.create(iconModule());
    const records = new Map();
    const keyOf = value => typeof value === 'string' ? value : value.url;
    const cache = {
        async keys() { return [...records.keys()].map(url => new Request(url)); },
        async match(key) { return records.get(keyOf(key))?.clone(); },
        async put(key, response) { records.set(keyOf(key), response.clone()); },
        async delete(key) { return records.delete(keyOf(key)); }
    };
    const meta = (id, value) => cache.put(new Request(`https://pabu.test/__pabu_bookmark_icon_cache__/${id}/meta`), new Response(JSON.stringify(value)));
    await meta('large-old', { lastUsedAt: 1, byteSize: 24 * 1024 * 1024 });
    await meta('large-new', { lastUsedAt: 2, byteSize: 24 * 1024 * 1024 });
    await meta('expired-failure', { lastUsedAt: Date.now() - 8 * 86400000, failure: 'fetch' });
    await app.trimBookmarkIconCache(cache);
    assert.equal(await cache.match('https://pabu.test/__pabu_bookmark_icon_cache__/large-old/meta'), undefined);
    assert.ok(await cache.match('https://pabu.test/__pabu_bookmark_icon_cache__/large-new/meta'));
    assert.equal(await cache.match('https://pabu.test/__pabu_bookmark_icon_cache__/expired-failure/meta'), undefined);
});

test('bookmark icons: quota errors clear the bounded cache and retry the current write once', async () => {
    const app = Object.create(iconModule());
    const records = new Map();
    let failOnce = true;
    let deletions = 0;
    const cache = {
        async keys() { return [...records.keys()].map(url => new Request(url)); },
        async match(key) { return records.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async put(key, response) {
            if (failOnce) { failOnce = false; const error = new Error('quota exceeded'); error.name = 'QuotaExceededError'; throw error; }
            records.set(typeof key === 'string' ? key : key.url, response.clone());
        },
        async delete(key) { return records.delete(typeof key === 'string' ? key : key.url); }
    };
    const cacheStorage = { async open() { return cache; }, async delete() { deletions++; records.clear(); return true; } };
    app.bookmarkIconMemory = new Map();
    app.bookmarkIconMemoryBytes = 0;
    app.bookmarkIconCacheEpoch = 0;
    app.bookmarkIconCacheKey = async (_key, part) => new Request(`https://pabu.test/__pabu_bookmark_icon_cache__/current/${part}`);
    await withGlobals({ window: { caches: cacheStorage }, caches: cacheStorage }, () => app.writeBookmarkIcon('auto:https://quota.test', { blob: new Blob(['image']), type: 'image/png' }));
    assert.equal(deletions, 1);
    assert.equal(records.size, 2);
});

test('bookmark icons: cached backoff does not count as a new failed request', async () => {
    const app = Object.create(iconModule());
    const img = { isConnected: true, dataset: { iconState: 'queued' } };
    const task = { key: 'auto:https://cooldown.test', mode: 'auto', controller: app.bookmarkIconController(), images: new Set([img]), deadline: Date.now() + 25000 };
    let failures = 0;
    app.fetchBookmarkIcon = async () => ({ nextCheckAt: Date.now() + 60000, nextRetryAt: Date.now() + 60000, failureCount: 3 });
    app.markBookmarkIconFailure = async () => { failures++; };
    app.showBookmarkIconRecord = async () => {};
    app.bookmarkIconTasks = new Map([[task.key, task]]);
    app.bookmarkIconActive = 1;
    app.bookmarkIconQueue = [];
    app.bookmarkIconImageTasks = new WeakMap();
    app.pumpBookmarkIcons = () => {};
    app.fillBookmarkIconQueue = () => {};
    await withGlobals({ navigator: { onLine: true } }, () => app.runBookmarkIconTask(task));
    assert.equal(failures, 0);
    assert.equal(img.dataset.iconState, 'failed');
});

test('bookmark icons: offline cache reads display a saved image without an API request', async () => {
    const app = Object.create(iconModule());
    const record = { blob: new Blob(['saved']), nextCheckAt: 0 };
    let displayed = 0;
    let requests = 0;
    app.readBookmarkIcon = async () => record;
    app.showBookmarkIconRecord = async (_task, value) => { assert.equal(value, record); displayed++; };
    app.bookmarkIconHash = async () => null;
    const task = { key: 'auto:https://offline.test', url: new URL('https://offline.test'), controller: app.bookmarkIconController() };
    await withGlobals({ navigator: { onLine: false }, fetch: async () => { requests++; } }, async () => {
        assert.equal(await app.fetchBookmarkIcon(task), record);
    });
    assert.equal(displayed, 1);
    assert.equal(requests, 0);
});

test('bookmark icons: cached image replacements advance the request sequence', async () => {
    const app = Object.create(iconModule());
    const img = { isConnected: true, dataset: { iconRequest: 'old' }, style: {}, nextElementSibling: null };
    const revoked = [];
    app.bookmarkIconSequence = 0;
    app.bookmarkIconObjectUrls = new WeakMap();
    await withGlobals({ URL: { createObjectURL: () => 'blob:new', revokeObjectURL: value => revoked.push(value) } }, async () => {
        app.bookmarkIconObjectUrls.set(img, 'blob:old');
        await app.showBookmarkIconRecord({ controller: { signal: { aborted: false } }, images: new Set([img]) }, { blob: new Blob(['new']) });
    });
    assert.equal(img.dataset.iconRequest, '1');
    assert.deepEqual(revoked, ['blob:old']);
});
