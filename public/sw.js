const CACHE = 'pabu-v50';
const ICON_CACHE = 'pabu-bookmark-icons-v1';
const ASSETS = [
    '/', '/index.html', '/styles.css', '/admin.css', '/themes.css',
    '/fonts/inter-tight-latin-variable.woff2', '/app.js', '/admin.js', '/bookmark-icons.js', '/share-code.js',
    '/navigation-schema.js', '/local-navigation.js', '/rtc-transfer.js', '/lib/qrcode.js',
    '/favicon.svg', '/icon.svg', '/manifest.json'
];
const ASSET_PATHS = new Set(ASSETS);
const IMMUTABLE_PATHS = new Set([
    '/fonts/inter-tight-latin-variable.woff2', '/lib/qrcode.js', '/favicon.svg', '/icon.svg'
]);

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE && key !== ICON_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !ASSET_PATHS.has(url.pathname)) return;
    if (IMMUTABLE_PATHS.has(url.pathname)) {
        event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
            if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
            return response;
        })));
        return;
    }
    // 网络优先：保证服务升级后 HTML 与各 JS 模块同版本加载，离线时再回退缓存。
    event.respondWith(
        fetch(event.request).then(response => {
            if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
            return response;
        }).catch(() => caches.match(event.request))
    );
});
