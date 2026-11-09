'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installation } = require('./helpers/installation');

function rtcHeaders(token, extra = {}) {
    return { 'X-Pabu-Rtc-Token': token, ...extra };
}

test('HTTP RTC signaling pairs two browsers and closes on cancel', async t => {
    const app = await installation(t, { env: { PABU_RTC_POLL_TIMEOUT: '40' } });
    await app.start();

    const configResponse = await app.request('/api/rtc/config');
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.ok(Array.isArray(config.iceServers));
    assert.ok(config.maxFileBytes > 0);

    const roomResponse = await app.request('/api/rtc/room', {
        body: { name: '说明.txt', size: 10, type: 'text/plain' }
    });
    assert.equal(roomResponse.status, 200);
    const room = await roomResponse.json();
    assert.match(room.code, /^[1-9]\d{4}$/);
    assert.equal(room.role, 'sender');
    assert.equal(typeof room.token, 'string');

    const joinResponse = await app.request('/api/rtc/join', { body: { code: room.code } });
    assert.equal(joinResponse.status, 200);
    const joined = await joinResponse.json();
    assert.equal(joined.role, 'receiver');
    assert.equal(joined.room.name, '说明.txt');

    const secondJoin = await app.request('/api/rtc/join', { body: { code: room.code } });
    assert.equal(secondJoin.status, 409);

    const sendOffer = await app.request('/api/rtc/send', {
        body: { code: room.code, message: { type: 'offer', sdp: 'v=0 offer' } },
        headers: rtcHeaders(room.token)
    });
    assert.equal(sendOffer.status, 200);

    const receiverPollResponse = await app.request('/api/rtc/poll', {
        body: { code: room.code, after: 0 },
        headers: rtcHeaders(joined.token)
    });
    assert.equal(receiverPollResponse.status, 200);
    const receiverPoll = await receiverPollResponse.json();
    assert.deepEqual(receiverPoll.messages.map(message => message.type), ['offer']);

    const sendAnswer = await app.request('/api/rtc/send', {
        body: { code: room.code, message: { type: 'answer', sdp: 'v=0 answer' } },
        headers: rtcHeaders(joined.token)
    });
    assert.equal(sendAnswer.status, 200);

    const senderPollResponse = await app.request('/api/rtc/poll', {
        body: { code: room.code, after: 0 },
        headers: rtcHeaders(room.token)
    });
    const senderPoll = await senderPollResponse.json();
    assert.deepEqual(senderPoll.messages.map(message => message.type), ['control', 'answer']);
    assert.equal(senderPoll.messages[0].event, 'peer-joined');

    const emptyPoll = await app.request('/api/rtc/poll', {
        body: { code: room.code, after: senderPoll.next },
        headers: rtcHeaders(joined.token)
    });
    assert.equal(emptyPoll.status, 200);
    assert.deepEqual((await emptyPoll.json()).messages, []);

    const forbidden = await app.request('/api/rtc/send', {
        body: { code: room.code, message: { type: 'offer', sdp: 'x' } },
        headers: rtcHeaders('wrong-token')
    });
    assert.equal(forbidden.status, 403);

    const cancelled = await app.request(`/api/rtc/room/${room.code}`, {
        method: 'DELETE',
        headers: rtcHeaders(room.token, { 'X-Pabu-Request': '1', Origin: app.base })
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).closed, true);

    const receiverCancel = await app.request('/api/rtc/poll', {
        body: { code: room.code, after: 0 },
        headers: rtcHeaders(joined.token)
    });
    assert.equal(receiverCancel.status, 200);
    const receiverCancelBody = await receiverCancel.json();
    assert.deepEqual(receiverCancelBody.messages.map(message => message.event), ['cancelled']);

    const gone = await app.request('/api/rtc/poll', {
        body: { code: room.code, after: receiverCancelBody.next },
        headers: rtcHeaders(joined.token)
    });
    assert.equal(gone.status, 410);
});

test('TURN 只下发短期凭据，不暴露静态用户名密码', async t => {
    const ice = JSON.stringify([
        { urls: 'stun:stun.example.com:3478' },
        { urls: 'turn:turn.example.com:3478', username: 'static-user', credential: 'static-pass' }
    ]);
    const app = await installation(t, { env: { PABU_RTC_ICE_SERVERS: ice, PABU_RTC_TURN_SECRET: 'secret' } });
    await app.start();

    const config = await (await app.request('/api/rtc/config')).json();
    const stun = config.iceServers.find(server => server.urls.startsWith('stun:'));
    const turn = config.iceServers.find(server => server.urls.startsWith('turn:'));
    assert.deepEqual(stun, { urls: 'stun:stun.example.com:3478' });
    assert.match(turn.username, /^\d+:pabu$/);
    assert.notEqual(turn.username, 'static-user');
    assert.notEqual(turn.credential, 'static-pass');
    assert.equal(typeof turn.credential, 'string');
});

test('没有 TURN 密钥时不下发 TURN 地址', async t => {
    const ice = JSON.stringify([{ urls: 'turn:turn.example.com:3478' }]);
    const app = await installation(t, { env: { PABU_RTC_ICE_SERVERS: ice } });
    await app.start();

    const config = await (await app.request('/api/rtc/config')).json();
    assert.equal(config.iceServers.some(server => server.urls.startsWith('turn:')), false);
});

test('加入取件码按 IP 限流', async t => {
    const app = await installation(t, { env: { PABU_RTC_POLL_TIMEOUT: '40' } });
    await app.start();

    let last;
    for (let attempt = 0; attempt < 31; attempt++) {
        last = await app.request('/api/rtc/join', { body: { code: '12345' } });
    }
    assert.equal(last.status, 429);
});

test('RTC endpoints require the same-origin header and validate tokens', async t => {
    const app = await installation(t, { env: { PABU_RTC_POLL_TIMEOUT: '40' } });
    await app.start();

    const csrf = await fetch(`${app.base}/api/rtc/room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: app.base },
        body: JSON.stringify({ name: 'a.txt', size: 10 })
    });
    assert.equal(csrf.status, 403);

    const missing = await app.request('/api/rtc/join', { body: { code: '12345' } });
    assert.equal(missing.status, 404);

    const room = await (await app.request('/api/rtc/room', {
        body: { name: 'a.txt', size: 10, type: 'text/plain' }
    })).json();

    const badToken = await app.request('/api/rtc/poll', {
        body: { code: room.code, after: 0 },
        headers: rtcHeaders('nope')
    });
    assert.equal(badToken.status, 403);

    const badMessage = await app.request('/api/rtc/send', {
        body: { code: room.code, message: { type: 'control', event: 'peer-joined' } },
        headers: rtcHeaders(room.token)
    });
    assert.equal(badMessage.status, 400);
});
