const CACHE = 'pabu-v27';
const ASSETS = [
    '/', '/index.html', '/styles.css', '/admin.css', '/themes.css',
    '/fonts/inter-tight-latin-variable.woff2', '/app.js', '/share-code.js',
    '/navigation-schema.js', '/local-navigation.js', '/rtc-transfer.js', '/lib/qrcode.js',
    '/favicon.svg', '/icon.svg', '/manifest.json'
];
const ASSET_PATHS = new Set(ASSETS);

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !ASSET_PATHS.has(url.pathname)) return;
    event.respondWith(caches.match(event.request).then(cached => {
        const fetched = fetch(event.request).then(response => {
            if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
            return response;
        }).catch(() => cached);
        return cached || fetched;
    }));
});
