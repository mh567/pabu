'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installation } = require('./helpers/installation');

test('HTTP boundary: retired private modules and agent services are unavailable', async (t) => {
    const app = await installation(t);
    await app.start();
    const login = await app.request('/api/verify-password', { password: 'admin123', body: {} });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const retired = [
        ['/api/favorites', 'GET'], ['/api/favorites', 'POST'],
        ['/api/webdav/config', 'GET'], ['/api/webdav/config', 'POST'],
        ['/api/modules/config', 'GET'], ['/api/modules/metrics', 'GET'],
        ['/api/modules/servers', 'POST'], ['/api/modules/enroll', 'POST'],
        ['/api/modules/agent-push', 'POST'],
        ['/api/memos', 'GET'], ['/api/memos', 'POST'],
        ['/api/todos', 'GET'], ['/api/todos', 'POST'],
        ['/api/timeline/events', 'GET'], ['/api/timeline/sources', 'GET'],
        ['/api/weibo-hot', 'GET'], ['/agent/install.sh', 'GET']
    ];
    for (const [route, method] of retired) {
        const response = await app.request(route, { method, cookie, ...(method === 'POST' ? { body: {} } : {}) });
        assert.equal(response.status, 404, `${method} ${route} should not exist`);
    }
});

test('HTTP core flow: encrypted text share is retrievable once and expires from service storage', async (t) => {
    const app = await installation(t);
    await app.start();
    const opaqueCiphertext = Buffer.from('ciphertext produced by Web Crypto').toString('base64');
    const codeResponse = await app.request('/api/p/code', { method: 'POST', body: {} });
    assert.equal(codeResponse.status, 200);
    const { code } = await codeResponse.json();
    const created = await app.request('/api/p', { body: { code, content: opaqueCiphertext, pin: '2468', ttl: 5 } });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).success, true);
    const needsPin = await app.request(`/api/p/${code}`, { body: {} });
    assert.equal((await needsPin.json()).requirePin, true);
    const fetched = await app.request(`/api/p/${code}`, { body: { pin: '2468' } });
    assert.equal((await fetched.json()).content, opaqueCiphertext);
    assert.equal((await app.request(`/api/p/${code}`, { body: { pin: '2468' } })).status, 404);
});
