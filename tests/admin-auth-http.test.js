'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installation } = require('./helpers/installation');

test('HTTP: /admin serves the dedicated admin shell without a front-page entry', async (t) => {
    const app = await installation(t);
    await app.start();
    for (const route of ['/admin', '/admin/']) {
        const res = await app.request(route);
        assert.equal(res.status, 200, `${route} 应返回管理页`);
        assert.match(res.headers.get('content-type') || '', /text\/html/);
        const html = await res.text();
        assert.match(html, /classList\.add\('admin-page'\)/, '管理页应先打上整页标记');
        assert.equal(html.includes('id="adminBtn"'), false, '首页管理按钮已移除');
    }
});

test('HTTP: weak password can only be changed, strong session protects navigation and survives restart', async (t) => {
    const app = await installation(t);
    await app.start();
    const login = async (password) => app.request('/api/verify-password', { password, body: {} });
    const unauthenticated = await app.request('/api/admin/navigation');
    assert.equal(unauthenticated.status, 401);
    const weakLogin = await login('admin123');
    assert.equal((await weakLogin.json()).passwordChangeRequired, true);
    const weakCookie = weakLogin.headers.get('set-cookie').split(';')[0];
    assert.match(weakCookie, /^pabu_session=/);
    assert.equal((await app.request('/api/admin/navigation', { cookie: weakCookie })).status, 401);

    const changed = await app.request('/api/change-password', {
        cookie: weakCookie,
        body: { currentPassword: 'admin123', newPassword: 'StrongPass123!' }
    });
    assert.equal(changed.status, 200);
    const adminCookie = changed.headers.get('set-cookie').split(';')[0];
    assert.match(adminCookie, /^pabu_session=/);
    assert.equal((await app.request('/api/admin/navigation', { cookie: adminCookie })).status, 200);
    await app.stop();
    await app.start();
    assert.equal((await app.request('/api/admin/navigation', { cookie: adminCookie })).status, 200);
    await app.request('/api/logout', { cookie: adminCookie, body: {} });
    assert.equal((await app.request('/api/admin/navigation', { cookie: adminCookie })).status, 401);
});
