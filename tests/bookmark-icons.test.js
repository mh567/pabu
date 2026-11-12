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
    has(sw, /const CACHE = 'pabu-v35'/, 'new icon module is installed through a new static cache version');
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

test('bookmark icons: unloaded images stay outside flex layout until loaded', () => {
    const app = read('app.js');
    has(app, /data-icon-state="idle" style="display:none"/, 'the image is outside flex layout until it loads');
    const image = app.match(/<img class="bookmark-icon"[^>]+>/)[0];
    assert.match(image, /loading="eager"/, 'the visibility queue starts loading hidden images without native lazy loading blocking onload');
});

test('bookmark icons: visibility observer tracks the bookmark when its image is hidden', async () => {
    const methods = iconModule();
    const app = Object.create(methods);
    const image = {};
    const card = {
        matches: selector => selector === '.bookmark',
        querySelector: selector => selector === '.bookmark-icon[data-icon-mode]' ? image : null
    };
    image.closest = selector => selector === '.bookmark' ? card : null;
    let observed;
    let queued;
    let cancelled = 0;
    class Observer {
        constructor(callback) { this.callback = callback; }
        observe(target) { observed = target; }
        unobserve() {}
    }
    app.queueBookmarkIcon = target => { queued = target; };
    app.cancelBookmarkIcon = () => { cancelled++; };
    const source = read('bookmark-icons.js');
    has(source, /bookmarkIconObserver\.observe\(this\.bookmarkIconObserverTarget\(img\)\)/, 'observes the card, which remains measurable while the image is hidden');
    await withGlobals({
        window: { IntersectionObserver: Observer, addEventListener() {} },
        IntersectionObserver: Observer,
        document: { addEventListener() {} }
    }, async () => {
        app.initBookmarkIcons();
        app.bookmarkIconObserver.observe(app.bookmarkIconObserverTarget(image));
        assert.equal(observed, card);
        app.bookmarkIconObserver.callback([{ target: card, isIntersecting: true, intersectionRatio: 1 }]);
        app.bookmarkIconObserver.callback([{ target: card, isIntersecting: false, intersectionRatio: 0 }]);
    });
    assert.equal(queued, image);
    assert.equal(cancelled, 0, 'scrolling away does not abort an already queued icon request');
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
    app.loadAutomaticBookmarkIcon = async task => { refreshTask = task; return { blob: new Blob(['x']) }; };
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
    app.loadAutomaticBookmarkIcon = async () => ({ nextCheckAt: Date.now() + 60000, nextRetryAt: Date.now() + 60000, failureCount: 3 });
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

test('bookmark icons: LAN discovery uses declared icons and remembers the successful URL', async () => {
    const app = Object.create(iconModule());
    app.readBookmarkIcon = async () => null;
    app.discoverLocalBookmarkIcons = async () => ['http://192.168.1.1/web/favicon.hash.ico'];
    const attempted = [];
    let saved;
    app.loadBookmarkImage = async url => { attempted.push(url); if (!url.includes('favicon.hash')) throw new Error('404'); return url; };
    app.writeBookmarkIcon = async (_key, record) => { saved = record; };
    const task = { key: 'local:http://192.168.1.1', mode: 'local', url: new URL('http://192.168.1.1/'), controller: new AbortController() };
    await withGlobals({ navigator: { onLine: true }, location: { origin: 'https://pabu.test' } }, async () => {
        assert.equal((await app.loadDirectBookmarkIcon(task)).src, 'http://192.168.1.1/web/favicon.hash.ico');
        assert.equal(saved.src, 'http://192.168.1.1/web/favicon.hash.ico');
        app.readBookmarkIcon = async () => saved;
        app.discoverLocalBookmarkIcons = async () => { throw new Error('must reuse cached URL'); };
        assert.equal((await app.loadDirectBookmarkIcon(task)).src, saved.src);
    });
});

test('bookmark icons: LAN pages without CORS still try the LuCI theme favicon', async () => {
    const app = Object.create(iconModule());
    app.readBookmarkIcon = async () => null;
    app.discoverLocalBookmarkIcons = async () => [];
    app.writeBookmarkIcon = async () => {};
    app.loadBookmarkImage = async url => { if (!url.endsWith('/luci-static/argon/icon/favicon-32x32.png')) throw new Error('404'); return url; };
    const task = { key: 'local:http://192.168.1.1', mode: 'local', url: new URL('http://192.168.1.1/'), controller: new AbortController() };
    await withGlobals({ navigator: { onLine: true }, location: { origin: 'https://pabu.test' } }, async () => {
        assert.equal((await app.loadDirectBookmarkIcon(task)).src, 'http://192.168.1.1/luci-static/argon/icon/favicon-32x32.png');
    });
});

test('bookmark icons: LAN discovery retries the web entry when the root redirect lacks CORS', async () => {
    const app = Object.create(iconModule());
    const requests = [];
    const link = { getAttribute: name => name === 'rel' ? 'shortcut icon' : 'favicon.hash.ico' };
    await withGlobals({
        DOMParser: class { parseFromString() { return { querySelectorAll: () => [link] }; } },
        fetch: async (url, options) => {
            requests.push(url);
            assert.equal(options.credentials, 'omit');
            if (requests.length === 1) throw new TypeError('Failed to fetch');
            return { ok: true, url, headers: new Headers({ 'content-type': 'text/html' }), body: new Blob(['<html>']).stream() };
        }
    }, async () => {
        const task = { url: new URL('http://192.168.1.1:8096/'), controller: new AbortController() };
        assert.deepEqual(await app.discoverLocalBookmarkIcons(task), ['http://192.168.1.1:8096/web/favicon.hash.ico']);
        assert.deepEqual(requests, ['http://192.168.1.1:8096/', 'http://192.168.1.1:8096/web/']);
    });
});

test('bookmark icons: public direct loading precedes the server and reuses its remembered URL', async () => {
    const app = Object.create(iconModule());
    let cache = { failure: 'fetch', failureCount: 3, nextRetryAt: Date.now() + 7200000 };
    app.readBookmarkIcon = async () => cache;
    app.writeBookmarkIcon = async (_key, value) => { cache = value; };
    const attempted = [];
    app.loadBookmarkImage = async url => { attempted.push(url); if (!url.includes('/static/image/')) throw new Error('404'); return url; };
    app.fetchBookmarkIcon = async () => { throw new Error('server must not be called'); };
    const task = { key: 'auto:https://www.nodeseek.com', url: new URL('https://www.nodeseek.com/private?token=secret'), controller: new AbortController() };
    await withGlobals({ navigator: { onLine: true } }, async () => {
        const result = await app.loadAutomaticBookmarkIcon(task);
        assert.equal(result.src, 'https://www.nodeseek.com/static/image/favicon/favicon-32x32.png');
        assert.equal(cache.failure, undefined);
        attempted.length = 0;
        assert.equal((await app.loadAutomaticBookmarkIcon(task)).src, result.src);
        assert.deepEqual(attempted, [result.src]);
    });
});

test('bookmark icons: public direct failure falls back to the server without involving providers', async () => {
    const app = Object.create(iconModule());
    app.readBookmarkIcon = async () => null;
    const attempts = [];
    app.loadBookmarkImage = async url => { attempts.push(url); throw new Error('blocked'); };
    const result = { blob: new Blob(['cached']) };
    app.fetchBookmarkIcon = async () => { attempts.push('server'); return result; };
    const task = { key: 'auto:https://example.com', url: new URL('https://example.com/bookmark?secret=1'), controller: new AbortController() };
    await withGlobals({ navigator: { onLine: true } }, async () => assert.equal(await app.loadAutomaticBookmarkIcon(task), result));
    assert.ok(attempts.length > 1);
    assert.equal(attempts.at(-1), 'server');
    assert.ok(attempts.slice(0, -1).every(url => new URL(url).origin === task.url.origin && !new URL(url).search));
});

test('bookmark icons: a fresh public Blob bypasses direct probes and network while offline', async () => {
    const app = Object.create(iconModule());
    const cached = { blob: new Blob(['cached']), nextCheckAt: Date.now() + 60000 };
    app.readBookmarkIcon = async () => cached;
    app.loadBookmarkImage = app.fetchBookmarkIcon = async () => { throw new Error('no network expected'); };
    await withGlobals({ navigator: { onLine: false } }, async () => assert.equal(await app.loadAutomaticBookmarkIcon({ key: 'auto:https://example.com' }), cached));
});

test('bookmark icons: strategy upgrades restart failure backoff without discarding saved images', async () => {
    const app = Object.create(iconModule());
    const blob = new Blob(['old']);
    app.readBookmarkIcon = async () => ({ blob, failureCount: 3 });
    let saved;
    app.writeBookmarkIcon = async (_key, record) => { saved = record; };
    await app.markBookmarkIconFailure({ key: 'local:http://router.lan' });
    assert.equal(saved.failureCount, 1);
    assert.equal(saved.blob, blob);
    assert.equal(saved.strategyVersion, 2);
});

test('bookmark icons: replacing a saved Blob with a direct URL removes the old disk image', async () => {
    const app = Object.create(iconModule());
    const records = new Map([['https://pabu.test/image', new Response('old')]]);
    const cache = { put: async (key, value) => records.set(key.url, value), delete: async key => records.delete(key.url) };
    app.bookmarkIconMemory = new Map();
    app.bookmarkIconCacheEpoch = 0;
    app.bookmarkIconCacheKey = async (_key, part) => new Request(`https://pabu.test/${part}`);
    app.trimBookmarkIconCache = async () => {};
    const storage = { open: async () => cache };
    await withGlobals({ window: { caches: storage }, caches: storage }, () => app.writeBookmarkIcon('auto:https://example.com', { src: 'https://example.com/favicon.ico' }, { image: false }));
    assert.equal(records.has('https://pabu.test/image'), false);
    assert.equal((await records.get('https://pabu.test/meta').json()).src, 'https://example.com/favicon.ico');
});

test('bookmark icons: current strategy failures retain backoff and cancellation stops fallback', async () => {
    const app = Object.create(iconModule());
    const cached = { failure: 'fetch', strategyVersion: 2, nextRetryAt: Date.now() + 60000 };
    app.readBookmarkIcon = async () => cached;
    app.loadBookmarkImage = app.fetchBookmarkIcon = async () => { throw new Error('must not request'); };
    const controller = new AbortController();
    const task = { key: 'auto:https://example.com', url: new URL('https://example.com'), controller };
    await withGlobals({ navigator: { onLine: true } }, async () => {
        assert.equal(await app.loadAutomaticBookmarkIcon(task), cached);
        app.readBookmarkIcon = async () => null;
        controller.abort();
        await assert.rejects(app.loadAutomaticBookmarkIcon(task), { name: 'AbortError' });
    });
});

test('bookmark icons: manually refreshing a public direct image reports success', async () => {
    const app = Object.create(iconModule());
    app.bookmarkIconController = () => new AbortController();
    app.withBookmarkIconTimeout = (_task, run) => run();
    app.loadAutomaticBookmarkIcon = async (_task, options) => { assert.equal(options.refresh, true); return { src: 'https://example.com/favicon.ico' }; };
    app.markBookmarkIconFailure = async () => { throw new Error('must not mark successful loading as failure'); };
    assert.equal(await app.refreshBookmarkIcon({ url: 'https://example.com' }), '');
});
