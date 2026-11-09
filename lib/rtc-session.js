'use strict';

const crypto = require('node:crypto');

// 二期实时传文件的会合码：纯 5 位数字，首位不为 0。
// 它与文本 v2 的 26 位散列 ID、一期文件的单词码都不重叠，
// 前端可以只看形状决定走哪条取件路径。
const CODE_PATTERN = /^[1-9]\d{4}$/;

const MESSAGE_TYPES = new Set(['offer', 'answer', 'candidate', 'control']);
// 客户端可以发的事件。其余事件（peer-joined / peer-left / cancelled / expired）
// 只由服务端生成，客户端伪造会被拒绝。
const CLIENT_CONTROL_EVENTS = new Set(['cancel', 'start', 'relay-pending', 'relay', 'received']);

const MAX_SDP_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 4 * 1024;

const DEFAULTS = {
    waitingTtlMs: 10 * 60 * 1000,
    activeTtlMs: 60 * 60 * 1000,
    closedTtlMs: 60 * 1000,
    pollTimeoutMs: 20 * 1000,
    maxRooms: 200,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    maxQueue: 400,
    // 单条 offer 最大 64 KiB，只按条数封顶会让一个房间堆到二十多 MB。
    // 每个参与者的待取队列同时受条数与字节数限制。
    maxQueueBytes: 256 * 1024
};

function fail(status, message, code) {
    return Object.assign(new Error(message), { status, code });
}

function cleanName(value) {
    const name = String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/]/g, '_')
        .trim()
        .slice(0, 200);
    return name || '文件';
}

function cleanType(value) {
    const type = String(value || '');
    return /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(type) ? type.slice(0, 120) : 'application/octet-stream';
}

function createRtcSessionStore(options = {}) {
    const now = options.now || (() => Date.now());
    const newToken = options.newToken || (() => crypto.randomBytes(24).toString('base64url'));
    const newCode = options.newCode || (() => String(crypto.randomInt(10000, 100000)));
    const limits = { ...DEFAULTS, ...(options.limits || {}) };

    const rooms = new Map();

    function tokenFor(room, role) {
        return role === 'sender' ? room.senderToken : room.receiverToken;
    }

    function publicRoom(room) {
        return {
            code: room.code,
            state: room.state,
            createdAt: room.createdAt,
            expiresAt: room.expiresAt,
            peerPresent: !!room.receiverToken,
            name: room.name,
            size: room.size,
            type: room.type
        };
    }

    function activeCount() {
        let count = 0;
        for (const room of rooms.values()) if (room.state !== 'closed') count += 1;
        return count;
    }

    function roomOrThrow(code) {
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw fail(400, '无效的取件码', 'code_invalid');
        const room = rooms.get(code);
        if (!room) throw fail(404, '取件码不存在或已过期', 'not_found');
        return room;
    }

    function participantOrThrow(code, token) {
        const room = roomOrThrow(code);
        if (typeof token !== 'string' || !token) throw fail(403, '会话凭据无效', 'token_invalid');
        if (token === room.senderToken) return { room, role: 'sender' };
        if (room.receiverToken && token === room.receiverToken) return { room, role: 'receiver' };
        throw fail(403, '会话凭据无效', 'token_invalid');
    }

    function snapshot(room, role, after) {
        const queue = room.queues[role];
        return {
            role,
            state: room.state,
            expiresAt: room.expiresAt,
            peerPresent: !!room.receiverToken,
            messages: queue.slice(),
            next: queue.length ? queue[queue.length - 1].seq : after
        };
    }

    function trim(room, role, after) {
        const queue = room.queues[role];
        let index = 0;
        while (index < queue.length && queue[index].seq <= after) {
            room.queuedBytes[role] -= queue[index].size || 0;
            index += 1;
        }
        if (room.queuedBytes[role] < 0) room.queuedBytes[role] = 0;
        if (index) queue.splice(0, index);
    }

    function resolveWaiters(room, role) {
        const waiters = room.waiters[role];
        if (!waiters || waiters.size === 0) return;
        for (const waiter of [...waiters]) {
            waiter.resolve(snapshot(room, role, waiter.after));
        }
    }

    function enqueue(room, role, message) {
        if (!tokenFor(room, role)) return;
        const queue = room.queues[role];
        const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (room.state !== 'closed'
            && (queue.length >= limits.maxQueue || room.queuedBytes[role] + size > limits.maxQueueBytes)) {
            closeRoom(room, 'overflow');
            return;
        }
        const entry = { seq: ++room.seq[role], at: now(), size, ...message };
        queue.push(entry);
        room.queuedBytes[role] += size;
        resolveWaiters(room, role);
    }

    function closeRoom(room, reason) {
        if (room.state === 'closed') return;
        room.state = 'closed';
        room.closedAt = now();
        room.expiresAt = now();
        enqueue(room, 'sender', { type: 'control', event: reason });
        enqueue(room, 'receiver', { type: 'control', event: reason });
        resolveWaiters(room, 'sender');
        resolveWaiters(room, 'receiver');
    }

    function touch(room) {
        if (room.state === 'waiting') return;
        room.expiresAt = now() + limits.activeTtlMs;
    }

    function normalizeMessage(fromRole, message) {
        if (!message || typeof message !== 'object') throw fail(400, '信令格式无效', 'signal_invalid');
        const type = message.type;
        if (!MESSAGE_TYPES.has(type)) throw fail(400, '信令类型无效', 'signal_invalid');

        if (type === 'offer' || type === 'answer') {
            if (type === 'offer' && fromRole !== 'sender') throw fail(400, '只有发送方可以创建连接', 'signal_invalid');
            if (type === 'answer' && fromRole !== 'receiver') throw fail(400, '只有接收方可以应答', 'signal_invalid');
            const sdp = message.sdp;
            if (typeof sdp !== 'string' || sdp.length === 0) throw fail(400, '连接描述无效', 'signal_invalid');
            if (Buffer.byteLength(sdp, 'utf8') > MAX_SDP_BYTES) throw fail(413, '连接描述过大', 'signal_too_large');
            return { type, sdp };
        }

        if (type === 'candidate') {
            const value = message.candidate;
            if (value == null) return { type, candidate: null };
            if (typeof value !== 'object') throw fail(400, '网络候选无效', 'signal_invalid');
            const candidate = {
                candidate: String(value.candidate || ''),
                sdpMid: value.sdpMid == null ? null : String(value.sdpMid).slice(0, 64),
                sdpMLineIndex: Number.isInteger(value.sdpMLineIndex) ? value.sdpMLineIndex : null
            };
            if (value.usernameFragment != null) candidate.usernameFragment = String(value.usernameFragment).slice(0, 256);
            if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_CANDIDATE_BYTES) {
                throw fail(413, '网络候选过大', 'signal_too_large');
            }
            return { type, candidate };
        }

        const event = message.event;
        if (!CLIENT_CONTROL_EVENTS.has(event)) throw fail(400, '控制信令无效', 'signal_invalid');
        if (event === 'relay') {
            const code = message.code;
            if (typeof code !== 'string' || !/^[a-z]{2,6}-\d{3}$/.test(code)) {
                throw fail(400, '回退取件码无效', 'signal_invalid');
            }
            return { type: 'control', event, code };
        }
        return { type: 'control', event };
    }

    function create(input = {}) {
        const size = input.size;
        if (!Number.isInteger(size) || size <= 0) throw fail(400, '文件大小无效', 'size_invalid');
        if (size > limits.maxFileBytes) throw fail(413, '文件过大', 'too_large');
        if (activeCount() >= limits.maxRooms) throw fail(503, '实时分享繁忙，请稍后再试', 'busy');

        let code = null;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const candidate = newCode();
            if (typeof candidate === 'string' && CODE_PATTERN.test(candidate) && !rooms.has(candidate)) {
                code = candidate;
                break;
            }
        }
        if (!code) throw fail(503, '实时分享繁忙，请稍后再试', 'busy');

        const token = newToken();
        const room = {
            code,
            senderToken: token,
            receiverToken: null,
            name: cleanName(input.name),
            size,
            type: cleanType(input.type),
            createdAt: now(),
            expiresAt: now() + limits.waitingTtlMs,
            state: 'waiting',
            seq: { sender: 0, receiver: 0 },
            queues: { sender: [], receiver: [] },
            queuedBytes: { sender: 0, receiver: 0 },
            waiters: { sender: new Set(), receiver: new Set() }
        };
        rooms.set(code, room);
        return { role: 'sender', token, expiresAt: room.expiresAt, room: publicRoom(room), code };
    }

    function join(code) {
        const room = roomOrThrow(code);
        if (room.state === 'closed') throw fail(410, '会话已结束', 'closed');
        if (now() > room.expiresAt) {
            closeRoom(room, 'expired');
            throw fail(410, '取件码已过期', 'expired');
        }
        if (room.receiverToken) throw fail(409, '这个取件码已被接收方使用', 'occupied');

        const token = newToken();
        room.receiverToken = token;
        room.state = 'paired';
        room.expiresAt = now() + limits.activeTtlMs;
        enqueue(room, 'sender', { type: 'control', event: 'peer-joined' });
        return { role: 'receiver', token, expiresAt: room.expiresAt, room: publicRoom(room) };
    }

    function send(code, token, message) {
        const { room, role } = participantOrThrow(code, token);
        if (room.state === 'closed') throw fail(410, '会话已结束', 'closed');
        touch(room);

        const normalized = normalizeMessage(role, message);
        if (normalized.type === 'control' && normalized.event === 'cancel') {
            closeRoom(room, 'cancelled');
            return { ok: true, closed: true };
        }
        if (role === 'sender' && !room.receiverToken) {
            throw fail(409, '接收方尚未加入', 'no_peer');
        }
        enqueue(room, role === 'sender' ? 'receiver' : 'sender', normalized);
        return { ok: true, closed: false };
    }

    // 长轮询：没有新消息时最多挂起 pollTimeoutMs。返回的 next 是客户端下次应该
    // 带回来的游标；消息只有在下一次请求确认游标后才会从队列里删除。
    function poll(code, token, after) {
        const { room, role } = participantOrThrow(code, token);
        const cursor = Number.isInteger(after) && after >= 0 ? after : 0;
        trim(room, role, cursor);

        const immediate = snapshot(room, role, cursor);
        if (immediate.messages.length > 0) return { promise: Promise.resolve(immediate), cancel() {} };
        if (room.state === 'closed') throw fail(410, '会话已结束', 'closed');

        touch(room);
        let settled = false;
        let timer = null;
        const waiter = { after: cursor, resolve: null };
        const promise = new Promise(resolve => {
            waiter.resolve = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                room.waiters[role].delete(waiter);
                resolve(value);
            };
            room.waiters[role].add(waiter);
            timer = setTimeout(() => waiter.resolve(snapshot(room, role, cursor)), limits.pollTimeoutMs);
        });
        return { promise, cancel: () => waiter.resolve(snapshot(room, role, cursor)) };
    }

    // 接收方离开时把这一轮的信令全部作废。
    // 只清令牌不清队列的话，下一个接收方 after=0 会先读到上一轮的
    // offer/candidate；它的 handleOffer 又会因为已有 pc 而忽略新 offer。
    function dropReceiver(room) {
        for (const waiter of [...room.waiters.receiver]) {
            waiter.resolve({
                role: 'receiver',
                state: room.state,
                expiresAt: room.expiresAt,
                peerPresent: false,
                messages: [],
                next: waiter.after
            });
        }
        room.waiters.receiver.clear();
        room.queues.sender.length = 0;
        room.queues.receiver.length = 0;
        room.queuedBytes.sender = 0;
        room.queuedBytes.receiver = 0;
        room.receiverToken = null;
    }

    function leave(code, token) {
        const { room, role } = participantOrThrow(code, token);
        if (room.state === 'closed') return { ok: true, role, closed: true };
        if (role === 'sender') {
            closeRoom(room, 'cancelled');
            return { ok: true, role, closed: true };
        }
        dropReceiver(room);
        room.state = 'waiting';
        room.expiresAt = now() + limits.waitingTtlMs;
        enqueue(room, 'sender', { type: 'control', event: 'peer-left' });
        return { ok: true, role, closed: false };
    }

    function meta(code) {
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return { exists: false };
        const room = rooms.get(code);
        if (!room) return { exists: false };
        return {
            exists: true,
            state: room.state,
            expired: room.state !== 'closed' && now() > room.expiresAt,
            peerPresent: !!room.receiverToken,
            expiresAt: room.expiresAt
        };
    }

    function sweep() {
        const current = now();
        let closed = 0;
        let removed = 0;
        for (const room of [...rooms.values()]) {
            if (room.state === 'closed') {
                if (current - room.closedAt > limits.closedTtlMs) {
                    rooms.delete(room.code);
                    removed += 1;
                }
            } else if (current > room.expiresAt) {
                closeRoom(room, 'expired');
                closed += 1;
            }
        }
        return { closed, removed };
    }

    function stats() {
        return {
            rooms: rooms.size,
            active: activeCount(),
            waiters: [...rooms.values()].reduce((sum, room) => sum + room.waiters.sender.size + room.waiters.receiver.size, 0),
            queueBytes: [...rooms.values()].reduce((sum, room) => sum + room.queuedBytes.sender + room.queuedBytes.receiver, 0)
        };
    }

    return {
        create,
        join,
        // 路由在扣限流额度前先验令牌，避免匿名请求按请求体里的码
        // 把任意会话的发送/轮询预算打满。
        authenticate: participantOrThrow,
        send,
        poll,
        leave,
        meta,
        sweep,
        stats,
        has: code => rooms.has(code)
    };
}

module.exports = {
    createRtcSessionStore,
    CODE_PATTERN,
    MESSAGE_TYPES,
    CLIENT_CONTROL_EVENTS,
    MAX_SDP_BYTES,
    MAX_CANDIDATE_BYTES
};
