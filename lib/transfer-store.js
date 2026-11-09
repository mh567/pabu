'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// 与 server.js 的 isPasteCodeFormat 保持一致。码是分享的唯一定位符，
// 同时作为文件名前缀，所以这里必须拒绝路径分隔符与其他越界字符。
const CODE_PATTERN = /^[a-z]{2,6}-\d{3}$/;

// AES-GCM 每个分片的信封开销：12 字节 IV 加 16 字节认证标签。
// 服务端不参与加密，只把它当作分片大小的上下界来校验。
const MIN_ENVELOPE = 16;
const MAX_ENVELOPE = 128;

const DEFAULTS = {
    maxFileBytes: 64 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
    maxEntries: 50,
    tokenTtlMs: 10 * 60 * 1000,
    partialTtlMs: 60 * 60 * 1000
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
    // 只接受 file.type 这类裸 MIME，避免把任意字符串回填进响应头。
    return /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(type) ? type.slice(0, 120) : 'application/octet-stream';
}

function createTransferStore(options = {}) {
    if (!options.directory) throw new Error('transfer store requires a directory');

    const directory = options.directory;
    const limits = { ...DEFAULTS, ...(options.limits || {}) };
    const now = options.now || (() => Date.now());
    const newToken = options.newToken || (() => crypto.randomBytes(24).toString('base64url'));

    const entries = new Map();
    const tokens = new Map();
    let totalBytes = 0;
    let prepared = null;

    async function prepare() {
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        // 元数据只在内存里，进程重启后所有旧分片都没有归属。
        // 启动时先清空，避免一次崩溃留下一地无法回收的 .bin。
        let names = [];
        try { names = await fsp.readdir(directory); } catch { names = []; }
        await Promise.all(names
            .filter(name => name.endsWith('.bin'))
            .map(name => fsp.rm(path.join(directory, name), { force: true }).catch(() => {})));
    }

    async function ready() {
        if (!prepared) prepared = prepare();
        return prepared;
    }

    function filePath(code) {
        return path.join(directory, `${code}.bin`);
    }

    function requireEntry(code) {
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw fail(400, '无效的分享码');
        const entry = entries.get(code);
        if (!entry) throw fail(404, '文件不存在或已过期');
        return entry;
    }

    async function remove(code) {
        const entry = entries.get(code);
        if (!entry) return false;
        entries.delete(code);
        totalBytes -= entry.storedSize;
        for (const [token, record] of tokens.entries()) {
            if (record.code === code) tokens.delete(token);
        }
        await fsp.rm(entry.filePath, { force: true }).catch(() => {});
        return true;
    }

    function isExpired(entry) {
        return now() > entry.expiresAt;
    }

    async function init(input = {}) {
        await ready();
        const code = input.code;
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw fail(400, '无效的分享码');
        if (entries.has(code)) throw fail(409, '分享码已被使用');

        const size = input.size;
        if (!Number.isInteger(size) || size <= 0) throw fail(400, '文件大小无效');
        if (size > limits.maxFileBytes) throw fail(413, '文件过大');

        const chunkSize = input.chunkSize;
        if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw fail(400, '分片大小无效');
        const chunkCount = Math.ceil(size / chunkSize);
        const chunkBytes = input.chunkBytes;
        if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) throw fail(400, '分片信封大小无效');
        if (chunkBytes > chunkSize + MAX_ENVELOPE) throw fail(400, '分片信封大小无效');

        const storedSize = input.storedSize;
        const overhead = storedSize - size;
        if (!Number.isInteger(storedSize) || overhead < chunkCount * MIN_ENVELOPE || overhead > chunkCount * MAX_ENVELOPE) {
            throw fail(400, '密文大小无效');
        }

        const pin = input.pin == null || input.pin === '' ? null : String(input.pin);
        if (pin && !/^\d{4}$/.test(pin)) throw fail(400, 'PIN 必须是 4 位数字');

        const downloads = input.downloads == null ? 1 : input.downloads;
        if (!Number.isInteger(downloads) || downloads < 1 || downloads > 5) throw fail(400, '取件次数无效');

        const ttlMs = input.ttlMs;
        if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw fail(400, '有效期无效');

        if (entries.size >= limits.maxEntries) throw fail(503, '文件服务繁忙，请稍后再试');
        if (totalBytes + storedSize > limits.maxTotalBytes) throw fail(503, '文件服务繁忙，请稍后再试');

        const target = filePath(code);
        const handle = await fsp.open(target, 'w', 0o600);
        try {
            await handle.truncate(storedSize);
        } finally {
            await handle.close();
        }

        const entry = {
            code,
            size,
            storedSize,
            chunkSize,
            chunkBytes,
            chunkCount,
            name: cleanName(input.name),
            type: cleanType(input.type),
            pin,
            downloads,
            remainingDownloads: downloads,
            attempts: 0,
            createdAt: now(),
            expiresAt: now() + ttlMs,
            parts: new Map(),
            receivedBytes: 0,
            uploading: true,
            filePath: target
        };
        entries.set(code, entry);
        totalBytes += storedSize;

        return {
            success: true,
            code,
            expiresAt: entry.expiresAt,
            chunkSize,
            chunkBytes,
            chunkCount
        };
    }

    async function writeChunk(code, index, buffer) {
        const entry = requireEntry(code);
        if (isExpired(entry)) {
            await remove(code);
            throw fail(404, '文件不存在或已过期');
        }
        if (!entry.uploading) throw fail(409, '文件已上传完成');
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail(400, '分片内容为空');
        if (!Number.isInteger(index) || index < 0 || index >= entry.chunkCount) throw fail(400, '分片序号无效');
        if (buffer.length > entry.chunkBytes) throw fail(413, '分片过大');
        if (index < entry.chunkCount - 1 && buffer.length !== entry.chunkBytes) {
            throw fail(400, '分片大小不正确');
        }

        const offset = index * entry.chunkBytes;
        if (offset + buffer.length > entry.storedSize) throw fail(413, '分片超出文件大小');

        const previous = entry.parts.get(index) || 0;
        const nextBytes = entry.receivedBytes - previous + buffer.length;
        if (nextBytes > entry.storedSize) throw fail(413, '分片超出文件大小');

        const handle = await fsp.open(entry.filePath, 'r+');
        try {
            await handle.write(buffer, 0, buffer.length, offset);
        } finally {
            await handle.close();
        }

        entry.parts.set(index, buffer.length);
        entry.receivedBytes = nextBytes;

        return {
            success: true,
            received: entry.parts.size,
            total: entry.chunkCount,
            bytes: entry.receivedBytes
        };
    }

    async function finish(code) {
        const entry = requireEntry(code);
        if (isExpired(entry)) {
            await remove(code);
            throw fail(404, '文件不存在或已过期');
        }
        if (!entry.uploading) throw fail(409, '文件已上传完成');

        if (entry.parts.size !== entry.chunkCount) {
            throw fail(409, `上传未完成，缺少 ${entry.chunkCount - entry.parts.size} 个分片`, 'incomplete');
        }
        if (entry.receivedBytes !== entry.storedSize) {
            throw fail(409, '文件大小不一致', 'size_mismatch');
        }

        entry.uploading = false;
        return {
            success: true,
            code,
            size: entry.size,
            name: entry.name,
            type: entry.type,
            expiresAt: entry.expiresAt,
            chunkCount: entry.chunkCount,
            chunkBytes: entry.chunkBytes,
            storedSize: entry.storedSize
        };
    }

    function meta(code) {
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
            throw fail(400, '无效的分享码');
        }
        const entry = entries.get(code);
        if (!entry) return { exists: false };
        return {
            exists: true,
            hasPin: !!entry.pin,
            uploading: entry.uploading,
            expired: isExpired(entry),
            expiresAt: entry.expiresAt
        };
    }

    async function access(code, pin) {
        const entry = requireEntry(code);
        if (isExpired(entry)) {
            await remove(code);
            throw fail(404, '文件不存在或已过期');
        }
        if (entry.uploading) throw fail(409, '文件尚未上传完成');
        if (entry.remainingDownloads <= 0) throw fail(404, '文件已被取走');

        if (entry.pin) {
            if (typeof pin !== 'string' || pin !== entry.pin) {
                entry.attempts += 1;
                if (entry.attempts >= 3) {
                    await remove(code);
                    throw fail(403, 'PIN 错误次数过多，文件已销毁', 'pin_destroyed');
                }
                throw fail(403, `PIN 错误，剩余 ${3 - entry.attempts} 次尝试`, 'pin_required');
            }
        }

        const token = newToken();
        const expiresAt = now() + limits.tokenTtlMs;
        tokens.set(token, { code, expiresAt, used: false });

        return {
            success: true,
            token,
            tokenExpiresAt: expiresAt,
            name: entry.name,
            size: entry.size,
            type: entry.type,
            chunkSize: entry.chunkSize,
            chunkBytes: entry.chunkBytes,
            chunkCount: entry.chunkCount,
            storedSize: entry.storedSize,
            expiresAt: entry.expiresAt,
            remainingDownloads: entry.remainingDownloads
        };
    }

    function consumeToken(token, expectedCode) {
        if (typeof token !== 'string' || !token) throw fail(403, '取件凭据无效');
        const record = tokens.get(token);
        if (!record) throw fail(403, '取件凭据无效或已过期');
        // 凭据只对签发它的那个分享码有效，避免拿 A 的凭据去下载 B。
        if (expectedCode && record.code !== expectedCode) throw fail(403, '取件凭据无效');
        if (record.used) throw fail(403, '取件凭据已使用');
        if (now() > record.expiresAt) {
            tokens.delete(token);
            throw fail(403, '取件凭据已过期');
        }

        const entry = requireEntry(record.code);
        if (isExpired(entry)) throw fail(404, '文件不存在或已过期');
        if (entry.uploading) throw fail(409, '文件尚未上传完成');
        if (entry.remainingDownloads <= 0) throw fail(404, '文件已被取走');

        record.used = true;
        return {
            code: entry.code,
            filePath: entry.filePath,
            size: entry.size,
            storedSize: entry.storedSize,
            name: entry.name,
            type: entry.type,
            chunkBytes: entry.chunkBytes,
            chunkCount: entry.chunkCount
        };
    }

    async function completeDownload(code) {
        const entry = entries.get(code);
        if (!entry) return { remaining: 0 };
        entry.remainingDownloads -= 1;
        if (entry.remainingDownloads <= 0) {
            await remove(code);
            return { remaining: 0 };
        }
        return { remaining: entry.remainingDownloads };
    }

    async function sweep() {
        const current = now();
        let removed = 0;
        for (const [code, entry] of [...entries.entries()]) {
            const partialExpired = entry.uploading && current - entry.createdAt > limits.partialTtlMs;
            if (current > entry.expiresAt || partialExpired) {
                await remove(code);
                removed += 1;
            }
        }
        for (const [token, record] of [...tokens.entries()]) {
            if (record.used || current > record.expiresAt) tokens.delete(token);
        }
        return { removed };
    }

    function stats() {
        return { entries: entries.size, bytes: totalBytes, tokens: tokens.size, limits: { ...limits } };
    }

    return {
        limits: { ...limits },
        ready,
        has: code => entries.has(code),
        init,
        writeChunk,
        finish,
        meta,
        access,
        consumeToken,
        completeDownload,
        remove,
        sweep,
        stats
    };
}

module.exports = { createTransferStore, CODE_PATTERN, MIN_ENVELOPE, MAX_ENVELOPE };
