'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { installation } = require('./helpers/installation');

const seed = {
    theme: 'dark',
    showBookmarkIcons: false,
    searchEngine: 'one',
    searchEngines: [{ id: 'one', name: 'Example', url: 'https://example.com/?q=' }],
    categories: [{ id: 'c', name: 'Site', bookmarks: [{ id: 'b', title: 'Link', url: 'https://example.com/' }] }],
    privacyMode: true,
    legacyPrivate: 'discard-me'
};

async function login(app) {
    const res = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
}

async function setup(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify(seed));
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    return { app, cookie: await login(app) };
}

test('HTTP: one site navigation is public, writable only by the administrator, and survives restart', async t => {
    const { app, cookie } = await setup(t);
    const initial = await (await app.request('/api/config')).json();
    assert.equal(initial.legacyPrivate, undefined);
    assert.equal(initial.privacyMode, undefined);
    assert.equal(initial.categories[0].name, 'Site');

    assert.equal((await app.request('/api/admin/navigation')).status, 401);
    const site = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.equal(site.revision, 1);
    assert.deepEqual(site.config, initial, '管理员读取的就是公开站点导航');
    assert.equal(site.config.legacyPrivate, undefined);

    assert.equal((await app.request('/api/config', { cookie, body: seed })).status, 409);

    const changed = structuredClone(site.config);
    changed.categories[0].name = 'Published edit';
    const body = { config: changed, revision: site.revision, operationId: 'site-save-1' };
    let res = await app.request('/api/admin/navigation', { cookie, body });
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.revision, 2);
    assert.equal((await (await app.request('/api/config')).json()).categories[0].name, 'Published edit');

    assert.deepEqual(await (await app.request('/api/admin/navigation', { cookie, body })).json(), saved, '同一操作重放同一结果');

    await app.stop();
    await app.start();
    assert.equal((await (await app.request('/api/config')).json()).categories[0].name, 'Published edit');
    assert.equal((await (await app.request('/api/admin/navigation', { cookie })).json()).revision, 2);
    assert.deepEqual(await (await app.request('/api/admin/navigation', { cookie, body })).json(), saved, '回执跨重启保留');

    assert.equal((await app.request('/api/admin/navigation', { cookie, body: { ...body, operationId: 'stale' } })).status, 409);
});

test('HTTP: invalid site writes and competing saves cannot change the public navigation', async t => {
    const { app, cookie } = await setup(t);
    const base = await (await app.request('/api/admin/navigation', { cookie })).json();

    for (const mutate of [
        c => { c.categories[0].bookmarks[0].url = 'javascript:alert(1)'; },
        c => { c.searchEngines = []; },
        c => { c.searchEngines.push(c.searchEngines[0]); },
        c => { c.searchEngines[0].url = 'file:///etc/passwd'; },
        c => { c.modules = { enabledModules: ['memo'] }; },
        c => { c.categories[0].password = 'secret'; },
        c => { c.searchEngine = 'missing'; },
        c => { c.searchEngines[0].url = 'https://example.com/{query}'; }
    ]) {
        const config = structuredClone(base.config);
        mutate(config);
        const res = await app.request('/api/admin/navigation', { cookie, body: { config, revision: base.revision, operationId: require('node:crypto').randomUUID() } });
        assert.equal(res.status, 400);
    }

    const writes = await Promise.all(['a', 'b'].map(name => {
        const config = structuredClone(base.config);
        config.categories[0].name = name;
        return app.request('/api/admin/navigation', { cookie, body: { config, revision: base.revision, operationId: name } });
    }));
    assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);

    const current = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.equal((await app.request('/api/admin/navigation', { cookie, body: { config: { ...current.config, credentials: 'new' }, revision: current.revision, operationId: 'inject' } })).status, 400);
    assert.equal((await app.request('/api/admin/navigation', { body: { config: base.config, revision: 1, operationId: 'anon' } })).status, 401);

    assert.equal((await app.request('/api/admin/default-homepage', { cookie })).status, 404);
    assert.equal((await app.request('/api/admin/default-homepage/draft', { cookie, body: {} })).status, 404);
    assert.equal((await app.request('/api/admin/default-homepage/publish', { cookie, body: {} })).status, 404);
});

test('HTTP: factory defaults and supported legacy bookmarks seed the site navigation', async t => {
    const fresh = await installation(t);
    await fresh.start();
    const initial = await (await fresh.request('/api/config')).json();
    assert.equal(initial.theme, 'auto');
    assert.equal(initial.searchEngine, 'google');
    assert.equal(initial.showBookmarkIcons, false, '新站点默认不显示导航图标');
    await fresh.stop();

    const legacy = { ...seed, bookmarks: seed.categories };
    delete legacy.categories;
    delete legacy.theme;
    delete legacy.showBookmarkIcons;
    const old = await installation(t);
    fs.writeFileSync(path.join(old.dir, 'config.json'), JSON.stringify(legacy));
    fs.writeFileSync(path.join(old.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await old.start();
    const cookie = await login(old);
    const migrated = await (await old.request('/api/config')).json();
    assert.equal(migrated.theme, 'auto');
    assert.equal(migrated.showBookmarkIcons, false, '缺少图标偏好时迁移为不显示');
    assert.equal(migrated.categories[0].name, 'Site');
    assert.equal(migrated.privacyMode, undefined);
    assert.equal(migrated.legacyPrivate, undefined);
    assert.deepEqual((await (await old.request('/api/admin/navigation', { cookie })).json()).config, migrated,
        '管理员读取与公开读取是同一份站点导航');
});
