'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRtcSessionStore } = require('../lib/rtc-session');

const MINUTE = 60 * 1000;

function makeStore(t, options = {}) {
    let clock = 1_700_000_000_000;
    let token = 0;
    let codes = options.codes ? [...options.codes] : null;
    const store = createRtcSessionStore({
        now: () => clock,
        newToken: () => `token-${++token}`,
        newCode: codes ? () => codes.shift() : undefined,
        limits: {
            waitingTtlMs: 10 * MINUTE,
            activeTtlMs: 60 * MINUTE,
            closedTtlMs: MINUTE,
            pollTimeoutMs: 20,
            ...(options.limits || {})
        }
    });
    return {
        store,
        advance(ms) { clock += ms; },
        now: () => clock
    };
}

const FILE = { name: '说明.txt', size: 10, type: 'text/plain' };

test('创建会话返回 5 位码，接收方加入后不能再被第二个人占用', t => {
    const { store } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    assert.equal(room.role, 'sender');
    assert.equal(room.code, '12345');
    assert.match(room.code, /^[1-9]\d{4}$/);
    assert.equal(room.room.name, '说明.txt');

    const joined = store.join('12345');
    assert.equal(joined.role, 'receiver');
    assert.equal(joined.room.size, 10);
    assert.equal(joined.room.peerPresent, true);
    assert.throws(() => store.join('12345'), /已被接收方使用/);
});

test('发送方与接收方通过队列交换 offer、answer 与候选', async t => {
    const { store } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    const joined = store.join(room.code);

    store.send(room.code, room.token, { type: 'offer', sdp: 'v=0 offer' });
    store.send(room.code, room.token, { type: 'candidate', candidate: { candidate: 'candidate:1', sdpMid: '0' } });
    const receiverPoll = await store.poll(room.code, joined.token, 0).promise;
    assert.deepEqual(receiverPoll.messages.map(m => m.type), ['offer', 'candidate']);
    assert.equal(receiverPoll.messages[0].sdp, 'v=0 offer');

    store.send(room.code, joined.token, { type: 'answer', sdp: 'v=0 answer' });
    const senderPoll = await store.poll(room.code, room.token, 0).promise;
    assert.deepEqual(senderPoll.messages.map(m => m.type), ['control', 'answer']);
    assert.equal(senderPoll.messages[0].event, 'peer-joined');
    assert.equal(senderPoll.messages[1].sdp, 'v=0 answer');

    const empty = await store.poll(room.code, joined.token, receiverPoll.next).promise;
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.next, receiverPoll.next);
});

test('信令鉴权与形状校验拒绝越权与超大内容', async t => {
    const { store } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    const joined = store.join(room.code);

    assert.throws(() => store.send(room.code, 'wrong', { type: 'offer', sdp: 'x' }), /凭据无效/);
    assert.throws(() => store.send(room.code, joined.token, { type: 'offer', sdp: 'x' }), /只有发送方/);
    assert.throws(() => store.send(room.code, room.token, { type: 'answer', sdp: 'x' }), /只有接收方/);
    assert.throws(() => store.send(room.code, room.token, { type: 'control', event: 'peer-joined' }), /控制信令无效/);
    assert.throws(() => store.send(room.code, room.token, { type: 'offer', sdp: 'x'.repeat(70 * 1024) }), /连接描述过大/);
    assert.throws(() => store.send(room.code, room.token, { type: 'control', event: 'relay', code: '../x' }), /回退取件码无效/);
});

test('没有接收方时发送方不能发 offer，但可以取消房间', async t => {
    const { store } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    assert.throws(() => store.send(room.code, room.token, { type: 'offer', sdp: 'x' }), /接收方尚未加入/);

    const result = store.send(room.code, room.token, { type: 'control', event: 'cancel' });
    assert.equal(result.closed, true);
    const senderPoll = await store.poll(room.code, room.token, 0).promise;
    assert.deepEqual(senderPoll.messages.map(m => m.event), ['cancelled']);
    assert.throws(() => store.poll(room.code, room.token, senderPoll.next), /会话已结束/);
});

test('接收方离开后房间回到等待状态，发送方收到 peer-left', async t => {
    const { store } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    const first = store.join(room.code);

    store.leave(room.code, first.token);
    const senderPoll = await store.poll(room.code, room.token, 0).promise;
    // 离开时清空队列，未被取走的 peer-joined 也会作废，只留 peer-left。
    assert.deepEqual(senderPoll.messages.map(m => m.event), ['peer-left']);

    const second = store.join(room.code);
    assert.equal(second.role, 'receiver');
    assert.equal(store.meta(room.code).peerPresent, true);
});

test('接收方离开会清空旧信令，新接收方从空队列开始', async t => {
    const { store } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    const first = store.join(room.code);

    store.send(room.code, room.token, { type: 'offer', sdp: 'OLD-OFFER' });
    store.send(room.code, room.token, { type: 'candidate', candidate: { candidate: 'old-candidate' } });
    const oldPoll = await store.poll(room.code, first.token, 0).promise;
    assert.deepEqual(oldPoll.messages.map(m => m.type), ['offer', 'candidate']);

    // 旧接收方还有一个挂起的长轮询，离开时它必须被就地结束。
    const pending = store.poll(room.code, first.token, oldPoll.next);
    store.leave(room.code, first.token);
    const pendingResult = await pending.promise;
    assert.deepEqual(pendingResult.messages, []);

    const second = store.join(room.code);
    const newPoll = await store.poll(room.code, second.token, 0).promise;
    assert.deepEqual(newPoll.messages, [], '新接收方不应读到上一轮的 offer 或候选');
});

test('中转回退的 relay-pending 与 relay 码按顺序送达接收方', async t => {
    const { store } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    const joined = store.join(room.code);

    store.send(room.code, room.token, { type: 'control', event: 'relay-pending' });
    store.send(room.code, room.token, { type: 'control', event: 'relay', code: 'tiger-123' });
    const poll = await store.poll(room.code, joined.token, 0).promise;
    assert.deepEqual(poll.messages.map(m => m.event), ['relay-pending', 'relay']);
    assert.equal(poll.messages[1].code, 'tiger-123');
});

test('信令队列按字节封顶，超限关闭房间', async t => {
    const { store } = makeStore(t, { codes: ['12345'], limits: { maxQueueBytes: 200 } });
    const room = store.create(FILE);
    const joined = store.join(room.code);

    store.send(room.code, room.token, { type: 'offer', sdp: 'x'.repeat(150) });
    store.send(room.code, room.token, { type: 'offer', sdp: 'y'.repeat(150) });
    const poll = await store.poll(room.code, joined.token, 0).promise;
    assert.equal(poll.state, 'closed');
    assert.ok(poll.messages.some(message => message.event === 'overflow'));
    assert.equal(store.meta(room.code).state, 'closed');
});

test('取消后接收方还能取走最后一条控制消息，再轮询返回 410', async t => {
    const { store } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    const joined = store.join(room.code);

    store.leave(room.code, room.token);
    const receiverPoll = await store.poll(room.code, joined.token, 0).promise;
    assert.deepEqual(receiverPoll.messages.map(m => m.event), ['cancelled']);
    assert.equal(receiverPoll.state, 'closed');

    assert.throws(() => store.poll(room.code, joined.token, receiverPoll.next), /会话已结束/);
});

test('配对后的房间按活动时间过期，关闭后由 sweep 回收', async t => {
    const { store, advance } = makeStore(t, { codes: ['12345'] });
    const room = store.create(FILE);
    store.join(room.code);

    advance(61 * MINUTE);
    assert.deepEqual(store.sweep(), { closed: 1, removed: 0 });
    assert.equal(store.meta(room.code).state, 'closed');

    advance(2 * MINUTE);
    assert.deepEqual(store.sweep(), { closed: 0, removed: 1 });
    assert.equal(store.has(room.code), false);
    assert.equal(store.stats().active, 0);
});

test('5 位码冲突时自动换一个码', t => {
    const { store } = makeStore(t, { codes: ['12345', '12345', '54321'] });
    assert.equal(store.create(FILE).code, '12345');
    assert.equal(store.create(FILE).code, '54321');
});

test('活跃房间达到上限后拒绝新建', t => {
    const { store } = makeStore(t, { codes: ['12345', '54321'], limits: { maxRooms: 1 } });
    assert.equal(store.create(FILE).code, '12345');
    assert.throws(() => store.create(FILE), /繁忙/);
});
