((root) => {
    'use strict';

    const BOOKMARK_ICON_CACHE = 'pabu-bookmark-icons-v1';
    const BOOKMARK_ICON_STRATEGY = 2;
    const BOOKMARK_ICON_MAX_ACTIVE = 4;
    const BOOKMARK_ICON_MAX_QUEUE = 500;
    const BOOKMARK_ICON_MAX_ENTRIES = 500;
    const BOOKMARK_ICON_MAX_BYTES = 32 * 1024 * 1024;
    class BookmarkIcons {
        initBookmarkIcons() {
            this.bookmarkIconMemory = new Map();
            this.bookmarkIconMemoryBytes = 0;
            this.bookmarkIconTasks = new Map();
            this.bookmarkIconImageTasks = new WeakMap();
            this.bookmarkIconQueue = [];
            this.bookmarkIconObjectUrls = new WeakMap();
            this.bookmarkIconSequence = 0;
            this.bookmarkIconCacheEpoch = 0;
            this.bookmarkIconActive = 0;
            this.bookmarkIconObserver = 'IntersectionObserver' in window
                ? new IntersectionObserver(entries => entries.forEach(entry => {
                    const img = entry.target.matches?.('.bookmark')
                        ? entry.target.querySelector('.bookmark-icon[data-icon-mode]')
                        : entry.target;
                    if (entry.isIntersecting && img) this.queueBookmarkIcon(img, entry.intersectionRatio);
                }), { rootMargin: '0px' })
                : null;
            window.addEventListener('online', () => this.resumeBookmarkIcons());
            window.addEventListener('offline', () => this.pauseBookmarkIcons());
            document.addEventListener('visibilitychange', () => document.hidden ? this.pauseBookmarkIcons() : this.resumeBookmarkIcons());
            if ('caches' in window) caches.open(BOOKMARK_ICON_CACHE).then(cache => this.trimBookmarkIconCache(cache)).catch(() => {});
        }

        bookmarkIconObserverTarget(img) {
            return img.closest?.('.bookmark') || img;
        }

        bookmarkIconHash(value) {
            if (!window.crypto?.subtle) return null;
            const bytes = new TextEncoder().encode(value);
            return window.crypto.subtle.digest('SHA-256', bytes).then(digest => [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
        }

        async bookmarkIconCacheKey(key, part) {
            const hash = await this.bookmarkIconHash(key);
            return hash && new Request(new URL(`/__pabu_bookmark_icon_cache__/${hash}/${part}`, location.origin));
        }

        bookmarkIconController() {
            if (typeof AbortController === 'function') {
                const controller = new AbortController();
                controller.fetchSignal = controller.signal;
                return controller;
            }
            let aborted = false;
            const listeners = new Set();
            return {
                fetchSignal: undefined,
                signal: {
                    get aborted() { return aborted; },
                    addEventListener: (name, listener) => { if (name === 'abort') listeners.add(listener); },
                    removeEventListener: (name, listener) => { if (name === 'abort') listeners.delete(listener); }
                },
                abort() { aborted = true; listeners.forEach(listener => listener()); listeners.clear(); }
            };
        }

        withBookmarkIconTimeout(task, run) {
            const remaining = Math.max(0, task.deadline - Date.now());
            if (!remaining || task.controller.signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
            let timer;
            let abort;
            const stopped = new Promise((resolve, reject) => {
                abort = () => reject(new DOMException('Aborted', 'AbortError'));
                task.controller.signal.addEventListener('abort', abort, { once: true });
            });
            const timeout = new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    task.expired = true;
                    task.controller.abort();
                    reject(new Error('图标请求超时'));
                }, remaining);
            });
            return Promise.race([Promise.resolve().then(run), stopped, timeout]).finally(() => {
                clearTimeout(timer);
                task.controller.signal.removeEventListener('abort', abort);
            });
        }

        async readBookmarkIcon(key) {
            const memory = this.bookmarkIconMemory.get(key);
            if (memory) {
                this.bookmarkIconMemory.delete(key);
                this.bookmarkIconMemory.set(key, memory);
                const accessedAt = Date.now();
                if (accessedAt - (memory.lastUsedAt || 0) > 60 * 60 * 1000) {
                    memory.lastUsedAt = accessedAt;
                    if ('caches' in window) this.bookmarkIconCacheKey(key, 'meta').then(async metaKey => {
                        const cache = await caches.open(BOOKMARK_ICON_CACHE);
                        const { blob, ...meta } = memory;
                        await cache.put(metaKey, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
                    }).catch(() => {});
                }
                return memory;
            }
            try {
                if (!('caches' in window)) return null;
                const imageKey = await this.bookmarkIconCacheKey(key, 'image');
                const metaKey = await this.bookmarkIconCacheKey(key, 'meta');
                if (!imageKey || !metaKey) return null;
                const cache = await caches.open(BOOKMARK_ICON_CACHE);
                const [image, meta] = await Promise.all([cache.match(imageKey), cache.match(metaKey)]);
                const details = meta ? await meta.json() : {};
                if (!image) {
                    if (!Object.keys(details).length) return null;
                    const accessedAt = Date.now();
                    if (accessedAt - (details.lastUsedAt || 0) > 60 * 60 * 1000) {
                        details.lastUsedAt = accessedAt;
                        await cache.put(metaKey, new Response(JSON.stringify(details), { headers: { 'Content-Type': 'application/json' } }));
                    }
                    return details;
                }
                const blob = await image.blob();
                const accessedAt = Date.now();
                const record = { blob, type: blob.type || image.headers.get('content-type') || 'image/png', ...details, lastUsedAt: accessedAt };
                this.rememberBookmarkIcon(key, record);
                if (accessedAt - (details.lastUsedAt || 0) > 60 * 60 * 1000) {
                    await cache.put(metaKey, new Response(JSON.stringify({ ...details, lastUsedAt: accessedAt }), { headers: { 'Content-Type': 'application/json' } }));
                }
                return record;
            } catch { return null; }
        }

        rememberBookmarkIcon(key, record) {
            if (!Number.isFinite(this.bookmarkIconMemoryBytes)) this.bookmarkIconMemoryBytes = 0;
            const previous = this.bookmarkIconMemory.get(key);
            if (previous) this.bookmarkIconMemoryBytes -= previous.blob?.size || 0;
            this.bookmarkIconMemory.delete(key);
            this.bookmarkIconMemory.set(key, record);
            this.bookmarkIconMemoryBytes += record.blob?.size || 0;
            while (this.bookmarkIconMemory.size > BOOKMARK_ICON_MAX_ENTRIES || this.bookmarkIconMemoryBytes > BOOKMARK_ICON_MAX_BYTES) {
                const oldest = this.bookmarkIconMemory.keys().next().value;
                this.bookmarkIconMemoryBytes -= this.bookmarkIconMemory.get(oldest)?.blob?.size || 0;
                this.bookmarkIconMemory.delete(oldest);
            }
        }

        async trimBookmarkIconCache(cache) {
            const keys = await cache.keys();
            const records = [];
            const metas = new Set(keys.filter(key => key.url.endsWith('/meta')).map(key => key.url));
            for (const metaKey of keys.filter(key => key.url.endsWith('/meta'))) {
                const imageKey = new Request(metaKey.url.replace(/\/meta$/, '/image'));
                const response = await cache.match(metaKey);
                try {
                    if (!response) {
                        await cache.delete(metaKey);
                        await cache.delete(imageKey);
                        continue;
                    }
                    const details = await response.json();
                    const lastUsedAt = Number(details.lastUsedAt) || 0;
                    if (details.failure && Date.now() - lastUsedAt > 7 * 86400000) {
                        await cache.delete(metaKey);
                        await cache.delete(imageKey);
                        continue;
                    }
                    const image = await cache.match(imageKey);
                    let imageSize = Number(details.byteSize);
                    if (!Number.isFinite(imageSize)) {
                        imageSize = image ? (await image.blob()).size : 0;
                        details.byteSize = imageSize;
                        await cache.put(metaKey, new Response(JSON.stringify(details), { headers: { 'Content-Type': 'application/json' } }));
                    }
                    records.push({ metaKey, imageKey, imageSize, lastUsedAt });
                } catch {
                    await cache.delete(metaKey);
                    await cache.delete(imageKey);
                }
            }
            for (const key of keys.filter(item => item.url.endsWith('/image'))) {
                if (!metas.has(key.url.replace(/\/image$/, '/meta'))) await cache.delete(key);
            }
            records.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
            let bytes = records.reduce((sum, record) => sum + record.imageSize, 0);
            while (records.length > BOOKMARK_ICON_MAX_ENTRIES || bytes > BOOKMARK_ICON_MAX_BYTES) {
                const oldest = records.shift();
                bytes -= oldest.imageSize;
                await cache.delete(oldest.metaKey);
                await cache.delete(oldest.imageKey);
            }
        }

        async writeBookmarkIcon(key, record, { image = true, epoch = this.bookmarkIconCacheEpoch, signal } = {}) {
            if (epoch !== this.bookmarkIconCacheEpoch || signal?.aborted) return;
            record = { ...record, lastUsedAt: Date.now() };
            this.rememberBookmarkIcon(key, record);
            if (!('caches' in window)) return;
            const store = async () => {
                const metaKey = await this.bookmarkIconCacheKey(key, 'meta');
                if (!metaKey || signal?.aborted || epoch !== this.bookmarkIconCacheEpoch) return;
                const cache = await caches.open(BOOKMARK_ICON_CACHE);
                if (image && record.blob) {
                    const imageKey = await this.bookmarkIconCacheKey(key, 'image');
                    if (signal?.aborted || epoch !== this.bookmarkIconCacheEpoch) return;
                    await cache.put(imageKey, new Response(record.blob, { headers: { 'Content-Type': record.type || record.blob.type || 'image/png' } }));
                }
                if (record.src && !record.blob) {
                    const imageKey = await this.bookmarkIconCacheKey(key, 'image');
                    if (signal?.aborted || epoch !== this.bookmarkIconCacheEpoch) return;
                    await cache.delete(imageKey);
                }
                if (signal?.aborted || epoch !== this.bookmarkIconCacheEpoch) return;
                const { blob, ...meta } = record;
                meta.byteSize = record.blob?.size || record.byteSize || 0;
                await cache.put(metaKey, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
                this.trimBookmarkIconCache(cache).catch(() => {});
            };
            try { await store(); }
            catch (error) {
                if (error.name !== 'QuotaExceededError' || signal?.aborted || epoch !== this.bookmarkIconCacheEpoch) return;
                try {
                    await caches.delete(BOOKMARK_ICON_CACHE);
                    await store();
                } catch { /* Cache Storage/quota errors fall back to memory and browser image loading. */ }
            }
        }

        async markBookmarkIconFailure(task, error) {
            const previous = await this.readBookmarkIcon(task.key);
            const previousFailures = previous?.strategyVersion === BOOKMARK_ICON_STRATEGY ? previous.failureCount || 0 : 0;
            const failureCount = error?.throttled ? previousFailures : previousFailures + 1;
            const delays = [300000, 1800000, 7200000, 86400000];
            const delay = error?.retryAfterMs ?? Math.round(delays[Math.min(failureCount - 1, delays.length - 1)] * (0.9 + Math.random() * 0.2));
            const nextRetryAt = Date.now() + delay;
            await this.writeBookmarkIcon(task.key, { ...(previous || {}), nextCheckAt: nextRetryAt, nextRetryAt, failureCount, failure: error?.throttled ? 'rate-limit' : 'fetch', strategyVersion: BOOKMARK_ICON_STRATEGY }, { image: false, epoch: task.epoch });
        }

        async withBookmarkIconLock(hash, signal, run) {
            if (!hash) return run();
            if (navigator.locks?.request && signal && typeof signal.throwIfAborted === 'function') return navigator.locks.request(`pabu-icon-${hash}`, { signal }, run);
            const name = `pabu-icon-lock-${hash}`;
            const owner = `${Date.now()}-${Math.random()}`;
            try {
                while (!signal.aborted) {
                    const current = JSON.parse(localStorage.getItem(name) || 'null');
                    if (!current || current.until < Date.now()) {
                        localStorage.setItem(name, JSON.stringify({ owner, until: Date.now() + 30000 }));
                        if (JSON.parse(localStorage.getItem(name) || 'null')?.owner === owner) break;
                    }
                    await new Promise((resolve, reject) => {
                        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
                        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 150);
                        signal.addEventListener('abort', abort, { once: true });
                    });
                }
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                return run();
            } finally {
                try { if (JSON.parse(localStorage.getItem(name) || 'null')?.owner === owner) localStorage.removeItem(name); } catch {}
            }
            return run();
        }

        bookmarkIconIsPrivate(url) {
            const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
            if (!host.includes('.') || /(?:^|\.)(?:localhost|local|lan|internal|home|home\.arpa)$/.test(host)) return true;
            if (host.includes(':')) return host === '::' || host === '::1' || /^(?:fc|fd|fe[89ab])/i.test(host) || host.startsWith('::ffff:');
            const ip = host.split('.').map(Number);
            if (ip.length !== 4 || ip.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
            return ip[0] === 0 || ip[0] === 10 || ip[0] === 127 || ip[0] >= 224
                || (ip[0] === 169 && ip[1] === 254) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31)
                || (ip[0] === 192 && ((ip[1] === 0 && (ip[2] === 0 || ip[2] === 2)) || ip[1] === 168 || ip[1] === 88 && ip[2] === 99))
                || (ip[0] === 198 && (ip[1] === 18 || ip[1] === 19 || ip[1] === 51 && ip[2] === 100))
                || (ip[0] === 203 && ip[1] === 0 && ip[2] === 113)
                || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127);
        }

        bookmarkIconImage(img, source) {
            const sequence = ++this.bookmarkIconSequence;
            img.dataset.iconRequest = String(sequence);
            const fallback = img.nextElementSibling;
            const previous = this.bookmarkIconObjectUrls.get(img);
            if (previous) URL.revokeObjectURL(previous);
            img.onload = () => {
                if (img.dataset.iconRequest !== String(sequence)) return;
                img.style.display = 'block';
                img.style.visibility = 'visible';
                if (fallback) fallback.style.display = 'none';
                img.dataset.iconState = 'loaded';
            };
            img.onerror = () => {
                if (img.dataset.iconRequest !== String(sequence)) return;
                img.style.display = 'none';
                if (fallback) fallback.style.display = 'grid';
                img.dataset.iconState = 'failed';
                if (img.dataset.iconMode === 'local') fallback.title = '浏览器可能阻止了本地网络或混合内容图标，已显示首字母';
            };
            img.style.display = 'none';
            img.referrerPolicy = 'no-referrer';
            img.dataset.iconState = 'loading';
            img.src = source;
        }

        async showBookmarkIconRecord(task, record) {
            if (!record?.blob || task.controller?.signal.aborted) return;
            for (const img of task.images || []) {
                if (!img.isConnected) continue;
                const src = URL.createObjectURL(record.blob);
                const old = this.bookmarkIconObjectUrls.get(img);
                if (old) URL.revokeObjectURL(old);
                this.bookmarkIconObjectUrls.set(img, src);
                const fallback = img.nextElementSibling;
                const sequence = String(++this.bookmarkIconSequence);
                img.dataset.iconRequest = sequence;
                img.onload = () => {
                    if (img.dataset.iconRequest !== sequence) return;
                    img.style.display = 'block';
                    img.style.visibility = 'visible';
                    if (fallback) fallback.style.display = 'none';
                    img.dataset.iconState = 'loaded';
                };
                img.onerror = () => {
                    if (img.dataset.iconRequest !== sequence) return;
                    img.style.display = 'none';
                    if (fallback) fallback.style.display = 'grid';
                    img.dataset.iconState = 'failed';
                };
                img.dataset.iconState = 'loading';
                img.src = src;
            }
        }

        async readBookmarkIconBytes(response, signal, limit = 2 * 1024 * 1024) {
            const declared = Number(response.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > limit) {
                await response.body?.cancel().catch(() => {});
                throw new Error('图标文件过大');
            }
            if (!response.body?.getReader) throw new Error('图标响应流不可用');
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            try {
                while (true) {
                    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > limit) {
                        await reader.cancel().catch(() => {});
                        throw new Error('图标文件过大');
                    }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            return bytes;
        }

        async loadAutomaticBookmarkIcon(task, { refresh = false } = {}) {
            const cached = await this.readBookmarkIcon(task.key);
            const fresh = Math.max(cached?.nextCheckAt || 0, cached?.nextRetryAt || 0) > Date.now();
            if (!refresh && fresh && (cached?.blob || (cached?.failure && cached.strategyVersion === BOOKMARK_ICON_STRATEGY))) return cached;
            if (!navigator.onLine) return cached;
            const deadline = Math.min(task.deadline || Infinity, Date.now() + 3000);
            const known = task.url.hostname === 'www.nodeseek.com' || task.url.hostname === 'nodeseek.com'
                ? ['/static/image/favicon/favicon-32x32.png'] : [];
            const candidates = [...new Set([...(cached?.src ? [cached.src] : []), ...[...known, '/favicon.ico', '/favicon.png', '/favicon.svg', '/apple-touch-icon.png'].map(path => new URL(path, task.url.origin).href)])];
            for (const url of candidates) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                if (task.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                try {
                    const src = await this.loadBookmarkImage(url, Math.min(1000, remaining), task.controller.signal);
                    const record = { src, source: 'browser', strategyVersion: BOOKMARK_ICON_STRATEGY, nextCheckAt: Date.now() + 30 * 86400000 };
                    await this.writeBookmarkIcon(task.key, record, { image: false, epoch: task.epoch, signal: task.controller.signal });
                    return record;
                } catch (error) { if (task.controller.signal.aborted) throw error; }
            }
            return this.fetchBookmarkIcon(task, { refresh });
        }

        async fetchBookmarkIcon(task, { refresh = false } = {}) {
            const cached = await this.readBookmarkIcon(task.key);
            if (!refresh && (cached?.blob || (cached?.failure && cached.strategyVersion === BOOKMARK_ICON_STRATEGY)) && Math.max(cached?.nextCheckAt || 0, cached?.nextRetryAt || 0) > Date.now()) return cached;
            if (cached?.blob) await this.showBookmarkIconRecord(task, cached);
            if (!navigator.onLine) return cached;
            const hash = await this.bookmarkIconHash(task.key);
            return this.withBookmarkIconLock(hash, task.controller.fetchSignal || task.controller.signal, async () => {
                const latest = await this.readBookmarkIcon(task.key);
                if (!refresh && (latest?.blob || (latest?.failure && latest.strategyVersion === BOOKMARK_ICON_STRATEGY)) && Math.max(latest?.nextCheckAt || 0, latest?.nextRetryAt || 0) > Date.now()) return latest;
                const origin = task.url.origin;
                const endpoint = new URL('/api/icon', location.origin);
                endpoint.searchParams.set('url', origin);
                if (refresh) endpoint.searchParams.set('refresh', '1');
                const headers = {};
                if (!refresh && latest?.etag) headers['If-None-Match'] = latest.etag;
                let response = await fetch(endpoint, { cache: 'no-store', credentials: 'omit', headers, ...(task.controller.fetchSignal ? { signal: task.controller.fetchSignal } : {}) });
                if (task.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                if (response.status === 304 && !latest?.blob && !refresh) {
                    response = await fetch(endpoint, { cache: 'no-store', credentials: 'omit', headers: {}, ...(task.controller.fetchSignal ? { signal: task.controller.fetchSignal } : {}) });
                    if (task.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                }
                const validatedAt = response.headers.get('X-Pabu-Icon-Validated-At') || new Date().toISOString();
                if (response.status === 304 && latest?.blob) {
                    const stale = ['1', 'true'].includes((response.headers.get('X-Pabu-Icon-Stale') || '').toLowerCase());
                    const record = { ...latest, etag: response.headers.get('ETag') || latest.etag, source: response.headers.get('X-Pabu-Icon-Source') || latest.source, validatedAt, nextCheckAt: Date.now() + (stale ? 300000 : 30 * 86400000), stale };
                    delete record.failure;
                    delete record.failureCount;
                    delete record.nextRetryAt;
                    await this.writeBookmarkIcon(task.key, record, { image: false, epoch: task.epoch, signal: task.controller.signal });
                    return record;
                }
                if (!response.ok || response.type === 'opaque') {
                    const retryHeader = response.headers.get('Retry-After');
                    const retryAt = Number(retryHeader);
                    const retryDate = Date.parse(retryHeader || '');
                    const error = new Error('图标获取失败');
                    error.throttled = response.status === 429 || response.status === 503;
                    error.retryAfterMs = !error.throttled ? undefined : retryHeader && Number.isFinite(retryAt)
                        ? Math.max(0, retryAt * 1000)
                        : retryHeader && Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : 60000;
                    throw error;
                }
                const type = response.headers.get('content-type') || '';
                if (!type.toLowerCase().startsWith('image/')) throw new Error('图标响应无效');
                const bytes = await this.readBookmarkIconBytes(response, task.controller.signal);
                if (task.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('图标文件过大');
                const stale = ['1', 'true'].includes((response.headers.get('X-Pabu-Icon-Stale') || '').toLowerCase());
                const record = { blob: new Blob([bytes], { type }), type, etag: response.headers.get('ETag'), source: response.headers.get('X-Pabu-Icon-Source'), validatedAt, stale, nextCheckAt: Date.now() + (stale ? 300000 : 30 * 86400000) };
                await this.validateBookmarkIconBlob(record.blob, task.controller.signal);
                delete record.failure;
                delete record.failureCount;
                delete record.nextRetryAt;
                await this.writeBookmarkIcon(task.key, record, { epoch: task.epoch, signal: task.controller.signal });
                return record;
            });
        }

        async validateBookmarkIconBlob(blob, signal) {
            const url = URL.createObjectURL(blob);
            try { await this.loadBookmarkImage(url, 3000, signal); }
            finally { URL.revokeObjectURL(url); }
        }

        async loadBookmarkImage(url, timeout, signal) {
            return new Promise((resolve, reject) => {
                const image = new Image();
                const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
                const timer = setTimeout(() => { clean(); image.src = ''; reject(new Error('图标加载超时')); }, timeout);
                const abort = () => { clean(); image.src = ''; reject(new DOMException('Aborted', 'AbortError')); };
                image.onload = () => { clean(); resolve(url); };
                image.onerror = () => { clean(); reject(new Error('图标加载失败')); };
                image.referrerPolicy = 'no-referrer';
                if (signal.aborted) { abort(); return; }
                signal.addEventListener('abort', abort, { once: true });
                image.src = url;
            });
        }

        async discoverLocalBookmarkIcons(task) {
            const controller = new AbortController();
            const abort = () => controller.abort();
            task.controller.signal.addEventListener('abort', abort, { once: true });
            if (task.controller.signal.aborted) controller.abort();
            const timer = setTimeout(abort, 1500);
            try {
                const options = { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal };
                let response;
                try { response = await fetch(task.url.href, options); }
                catch (error) {
                    if (controller.signal.aborted) throw error;
                    response = await fetch(new URL('/web/', task.url.origin).href, options);
                }
                if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) return [];
                const bytes = await this.readBookmarkIconBytes(response, controller.signal, 256 * 1024);
                const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'text/html');
                const base = new URL(response.url);
                // Only probe this bookmarked service, even if its HTML declares another host.
                if (base.origin !== task.url.origin) return [];
                return [...doc.querySelectorAll('link[rel]')]
                    .filter(link => /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(link.getAttribute('rel')))
                    .map(link => { try { return new URL(link.getAttribute('href'), base); } catch { return null; } })
                    .filter(url => url && url.origin === base.origin && !url.username && !url.password)
                    .map(url => url.href).slice(0, 6);
            } catch (error) {
                if (task.controller.signal.aborted) throw error;
                return [];
            } finally {
                clearTimeout(timer);
                task.controller.signal.removeEventListener('abort', abort);
            }
        }

        async loadDirectBookmarkIcon(task, { refresh = false } = {}) {
            const url = task.url;
            const cached = refresh ? null : await this.readBookmarkIcon(task.key);
            if ((cached?.blob || (cached?.failure && cached.strategyVersion === BOOKMARK_ICON_STRATEGY)) && Math.max(cached?.nextCheckAt || 0, cached?.nextRetryAt || 0) > Date.now()) return cached;
            if (cached?.blob) await this.showBookmarkIconRecord(task, cached);
            if (!navigator.onLine) return cached;
            if (task.mode === 'local' && cached?.src && cached.nextCheckAt > Date.now()) {
                try { return { ...cached, src: await this.loadBookmarkImage(cached.src, 1500, task.controller.signal) }; }
                catch (error) { if (task.controller.signal.aborted) throw error; }
            }
            if (url.origin === location.origin) {
                const response = await fetch(url, { cache: 'no-store', credentials: 'omit', ...(task.controller.fetchSignal ? { signal: task.controller.fetchSignal } : {}) });
                if (task.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                if (response.ok && response.type !== 'opaque' && (response.headers.get('content-type') || '').startsWith('image/')) {
                    const bytes = await this.readBookmarkIconBytes(response, task.controller.signal);
                    const record = { blob: new Blob([bytes], { type: response.headers.get('content-type') }), type: response.headers.get('content-type'), nextCheckAt: Date.now() + 30 * 86400000 };
                    await this.validateBookmarkIconBlob(record.blob, task.controller.signal);
                    await this.writeBookmarkIcon(task.key, record, { epoch: task.epoch, signal: task.controller.signal });
                    return record;
                }
            }
            if (task.mode === 'local') {
                const started = Date.now();
                const declared = await this.discoverLocalBookmarkIcons(task);
                const candidates = [...new Set([...declared, ...['/favicon.ico', '/favicon.png', '/apple-touch-icon.png', '/luci-static/argon/icon/favicon-32x32.png', '/luci-static/argon/favicon.ico', '/luci-static/bootstrap/favicon.ico'].map(path => new URL(path, url.origin).href)])];
                for (const path of candidates) {
                    const remaining = 8000 - (Date.now() - started);
                    if (remaining <= 0) break;
                    const candidate = new URL(path, url.origin);
                    try {
                        if (candidate.origin === location.origin) {
                            const response = await fetch(candidate, { cache: 'no-store', credentials: 'omit', ...(task.controller.fetchSignal ? { signal: task.controller.fetchSignal } : {}) });
                            if (task.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                            const type = response.headers.get('content-type') || '';
                            if (response.ok && type.startsWith('image/')) {
                                const bytes = await this.readBookmarkIconBytes(response, task.controller.signal);
                                const record = { blob: new Blob([bytes], { type }), type, nextCheckAt: Date.now() + 30 * 86400000 };
                                await this.validateBookmarkIconBlob(record.blob, task.controller.signal);
                                await this.writeBookmarkIcon(task.key, record, { epoch: task.epoch, signal: task.controller.signal });
                                return record;
                            }
                            continue;
                        }
                        const src = await this.loadBookmarkImage(candidate.href, Math.min(1000, remaining), task.controller.signal);
                        const record = { src, nextCheckAt: Date.now() + 30 * 86400000 };
                        await this.writeBookmarkIcon(task.key, record, { image: false, epoch: task.epoch, signal: task.controller.signal });
                        return record;
                    }
                    catch (error) { if (error.name === 'AbortError') throw error; }
                }
                return null;
            }
            return { src: await this.loadBookmarkImage(url.href, 3000, task.controller.signal) };
        }

        queueBookmarkIcon(img, priority = 0) {
            if (!img.isConnected || document.hidden || ['loaded', 'loading', 'failed'].includes(img.dataset.iconState)) return;
            const mode = img.dataset.iconMode;
            let url;
            try { url = new URL(mode === 'custom' ? img.dataset.iconUrl : img.dataset.bookmarkUrl); } catch { return; }
            const key = mode === 'auto' || mode === 'local' ? `${mode}:${url.origin}` : `custom:${url.href}`;
            const existing = this.bookmarkIconTasks.get(key);
            if (existing && !existing.controller.signal.aborted) { existing.images.add(img); this.bookmarkIconImageTasks.set(img, existing); img.dataset.iconState = 'queued'; return; }
            if (existing) this.bookmarkIconTasks.delete(key);
            if (this.bookmarkIconQueue.length >= BOOKMARK_ICON_MAX_QUEUE) { img.dataset.iconState = 'waiting'; return; }
            const budget = mode === 'auto' ? 25000 : mode === 'local' ? 8000 : 3000;
            const task = { key, url, mode, priority, images: new Set([img]), controller: this.bookmarkIconController(), deadline: Date.now() + budget };
            task.epoch = this.bookmarkIconCacheEpoch;
            this.bookmarkIconTasks.set(key, task);
            this.bookmarkIconImageTasks.set(img, task);
            img.dataset.iconState = 'queued';
            task.timeout = setTimeout(() => { task.expired = true; task.controller.abort(); }, budget);
            this.bookmarkIconQueue.push(task);
            this.bookmarkIconQueue.sort((a, b) => b.priority - a.priority);
            this.pumpBookmarkIcons();
        }

        async runBookmarkIconTask(task) {
            task.started = true;
            try {
                const result = await this.withBookmarkIconTimeout(task, () => task.mode === 'auto'
                    ? this.loadAutomaticBookmarkIcon(task)
                    : this.loadDirectBookmarkIcon(task));
                if (task.controller.signal.aborted) return;
                if (result?.blob) await this.showBookmarkIconRecord(task, result);
                else if (result?.src) for (const img of task.images) this.bookmarkIconImage(img, result.src);
                else if (Math.max(result?.nextCheckAt || 0, result?.nextRetryAt || 0) > Date.now()) {
                    for (const img of task.images) if (img.dataset.iconState !== 'loaded') img.dataset.iconState = 'failed';
                }
                else {
                    if (navigator.onLine) await this.markBookmarkIconFailure(task);
                    else for (const img of task.images) if (img.dataset.iconState !== 'loaded') img.dataset.iconState = 'failed';
                    if (task.mode === 'local') for (const img of task.images) {
                    const fallback = img.nextElementSibling;
                    if (img.dataset.iconState !== 'loaded') img.dataset.iconState = 'failed';
                    if (fallback) fallback.title = '浏览器可能阻止了本地网络或混合内容图标，已显示首字母';
                    }
                }
            } catch (error) {
                const state = error.name === 'AbortError' && !task.expired ? 'waiting' : 'failed';
                for (const img of task.images) if (img.dataset.iconState !== 'loaded') img.dataset.iconState = state;
                if (navigator.onLine && (error.name !== 'AbortError' || task.expired)) {
                    await this.markBookmarkIconFailure(task, error);
                }
            } finally {
                clearTimeout(task.timeout);
                if (this.bookmarkIconTasks.get(task.key) === task) this.bookmarkIconTasks.delete(task.key);
                this.bookmarkIconActive--;
                if (task.controller.signal.aborted) for (const img of task.images) if (img.isConnected && img.dataset.iconState !== 'loaded') img.dataset.iconState = task.expired ? 'failed' : 'waiting';
                this.pumpBookmarkIcons();
                this.fillBookmarkIconQueue();
            }
        }

        pumpBookmarkIcons() {
            while (!document.hidden && this.bookmarkIconActive < BOOKMARK_ICON_MAX_ACTIVE && this.bookmarkIconQueue.length) {
                const task = this.bookmarkIconQueue.shift();
                if (task.controller.signal.aborted) {
                    clearTimeout(task.timeout);
                    if (this.bookmarkIconTasks.get(task.key) === task) this.bookmarkIconTasks.delete(task.key);
                    for (const img of task.images) if (img.isConnected && img.dataset.iconState !== 'loaded') img.dataset.iconState = task.expired ? 'failed' : 'waiting';
                    if (task.expired && navigator.onLine) this.markBookmarkIconFailure(task);
                    continue;
                }
                this.bookmarkIconActive++;
                this.runBookmarkIconTask(task);
            }
            this.fillBookmarkIconQueue();
        }

        fillBookmarkIconQueue() {
            if (!this.homeSurface) return;
            const visible = [];
            for (const img of document.querySelectorAll('.bookmark-icon[data-icon-mode][data-icon-state="waiting"]')) {
                if (!img.isConnected) continue;
                const box = this.bookmarkIconObserverTarget(img).getBoundingClientRect();
                if (box.bottom >= 0 && box.top <= innerHeight) visible.push(img);
            }
            visible.forEach(img => { img.dataset.iconState = 'idle'; this.queueBookmarkIcon(img, 1); });
        }

        cancelBookmarkIcon(img) {
            if (img.dataset.iconState === 'loaded') return;
            const task = this.bookmarkIconImageTasks.get(img);
            if (task) {
                task.images.delete(img);
                this.bookmarkIconImageTasks.delete(img);
                if (!task.images.size) {
                    task.controller.abort();
                    this.bookmarkIconQueue = this.bookmarkIconQueue.filter(queued => queued !== task);
                    if (!task.started) { clearTimeout(task.timeout); this.bookmarkIconTasks.delete(task.key); }
                }
            }
            const objectUrl = this.bookmarkIconObjectUrls.get(img);
            if (objectUrl) { URL.revokeObjectURL(objectUrl); this.bookmarkIconObjectUrls.delete(img); }
            img.onload = img.onerror = null;
            img.removeAttribute('src');
            img.dataset.iconState = 'idle';
        }

        pauseBookmarkIcons() {
            for (const task of this.bookmarkIconTasks.values()) {
                task.controller.abort();
                for (const img of task.images) if (img.dataset.iconState !== 'loaded') img.dataset.iconState = 'waiting';
            }
            for (const task of this.bookmarkIconQueue) {
                clearTimeout(task.timeout);
                if (this.bookmarkIconTasks.get(task.key) === task) this.bookmarkIconTasks.delete(task.key);
            }
            this.bookmarkIconQueue.length = 0;
            for (const img of document.querySelectorAll('.bookmark-icon[data-icon-mode]')) this.bookmarkIconObserver?.unobserve(this.bookmarkIconObserverTarget(img));
        }

        resumeBookmarkIcons() {
            if (document.hidden || !navigator.onLine) return;
            for (const img of document.querySelectorAll('.bookmark-icon[data-icon-mode]')) {
                if (img.dataset.iconState !== 'loaded') {
                    if (img.dataset.iconState === 'failed') img.dataset.iconState = 'idle';
                    if (this.bookmarkIconObserver) this.bookmarkIconObserver.observe(this.bookmarkIconObserverTarget(img));
                    else this.queueBookmarkIcon(img, 0);
                }
            }
            this.pumpBookmarkIcons();
        }

        async clearBookmarkIconCache() {
            this.bookmarkIconCacheEpoch++;
            this.pauseBookmarkIcons();
            this.bookmarkIconMemory.clear();
            this.bookmarkIconMemoryBytes = 0;
            try { if ('caches' in window) await caches.delete(BOOKMARK_ICON_CACHE); } catch {}
            this.showToast('本机图标缓存已清除');
            this.renderGrid();
            if (this.siteSurface) this.renderGrid(this.siteSurface);
        }

        async refreshBookmarkIcon(bookmark) {
            let url;
            try { url = new URL(bookmark.iconUrl || bookmark.url); } catch { return '图标地址无效'; }
            if (bookmark.iconUrl) {
                try {
                    if (url.origin === location.origin) {
                        const task = { key: `custom:${url.href}`, url, mode: 'custom', controller: this.bookmarkIconController(), images: new Set(), epoch: this.bookmarkIconCacheEpoch, deadline: Date.now() + 3000 };
                        const result = await this.withBookmarkIconTimeout(task, () => this.loadDirectBookmarkIcon(task, { refresh: true }));
                        if (!result) throw new Error();
                    } else {
                        const task = { controller: this.bookmarkIconController(), deadline: Date.now() + 3000 };
                        await this.withBookmarkIconTimeout(task, () => this.loadBookmarkImage(url.href, 3000, task.controller.signal));
                    }
                    return '';
                } catch { return '图标刷新失败，已保留当前图标'; }
            }
            if (this.bookmarkIconIsPrivate(url)) {
                const task = { key: `local:${url.origin}`, url, mode: 'local', controller: this.bookmarkIconController(), images: new Set(), epoch: this.bookmarkIconCacheEpoch, deadline: Date.now() + 8000 };
                try { if (await this.withBookmarkIconTimeout(task, () => this.loadDirectBookmarkIcon(task, { refresh: true }))) return ''; } catch {}
                return '浏览器可能阻止了本地网络或混合内容图标，已显示首字母';
            }
            const task = { key: `auto:${url.origin}`, url, mode: 'auto', controller: this.bookmarkIconController(), images: new Set(), epoch: this.bookmarkIconCacheEpoch, deadline: Date.now() + 25000 };
            try {
                const result = await this.withBookmarkIconTimeout(task, () => this.loadAutomaticBookmarkIcon(task, { refresh: true }));
                if (result?.blob || result?.src) return '';
                throw new Error();
            } catch (error) {
                if (error.name !== 'AbortError' || task.expired) await this.markBookmarkIconFailure(task, error);
                return '图标刷新失败，已保留当前图标';
            }
        }

    }

    if (typeof module !== 'undefined' && module.exports) module.exports = BookmarkIcons.prototype;
    else root.BookmarkIconMethods = BookmarkIcons.prototype;
})(globalThis);
