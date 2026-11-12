'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');

const DAY = 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 16 * 1024 * 1024;
const HTML_READ_LIMIT = 256 * 1024;
const MANIFEST_READ_LIMIT = 64 * 1024;
const MAX_ICON_CANDIDATES = 6;
const MAX_DECLARED_CANDIDATES = 3;
const MAX_REQUEST_MS = 5000;
const THIRD_PARTY_RESERVE_MS = 5000;
const RESPONSE_HEADER_LIMIT = 64 * 1024;
const MAX_REDIRECTS = 3;
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 8, maxFreeSockets: 4 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 8, maxFreeSockets: 4 });
const JOB_BUDGET_MS = 20000;
const QUEUE_WAIT_MS = 3000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 60 * 1000;
const DEFAULT_CACHE_DIR = path.join(process.cwd(), '.icon-cache');
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'localhost']);

function ipv4Number(address) {
    return address.split('.').reduce((n, octet) => (n << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6Number(address) {
    if (address.includes('%')) return null;
    let input = address.toLowerCase();
    if (input.includes('.')) {
        const lastColon = input.lastIndexOf(':');
        const v4 = input.slice(lastColon + 1);
        if (net.isIP(v4) !== 4) return null;
        const n = ipv4Number(v4);
        input = `${input.slice(0, lastColon)}:${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
    }
    const halves = input.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
    const parts = halves.length === 2 ? [...left, ...Array(zeros).fill('0'), ...right] : left;
    if (parts.length !== 8) return null;
    return parts.reduce((n, part) => (n << 16n) | BigInt(parseInt(part || '0', 16)), 0n);
}

function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
        const n = ipv4Number(address);
        const ranges = [
            ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
            ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
            ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
            ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
        ];
        return !ranges.some(([base, bits]) => {
            const mask = ((1n << 32n) - 1n) ^ ((1n << BigInt(32 - bits)) - 1n);
            return (n & mask) === (ipv4Number(base) & mask);
        });
    }
    if (family !== 6) return false;
    const n = ipv6Number(address);
    if (n === null) return false;
    const globalPrefix = n >> 125n;
    if (globalPrefix !== 1n) return false; // Only global unicast 2000::/3 is eligible.
    const first16 = Number((n >> 112n) & 0xffffn);
    const second16 = Number((n >> 96n) & 0xffffn);
    return !(first16 === 0x2001 && second16 < 0x200) && first16 !== 0x2002 &&
        !(first16 === 0x2001 && second16 === 0x0db8) && first16 !== 0x5f00 && (n >> 108n) !== 0x3fff0n;
}

function isBlockedHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return !host || BLOCKED_HOSTS.has(host) || host.endsWith('.metadata.google.internal') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
        (net.isIP(host) !== 0 && !isPublicAddress(host));
}

function createPinnedLookup(address) {
    const family = net.isIP(address);
    return (_hostname, options, callback) => {
        if (typeof options === 'function') callback = options;
        if (options && options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
    };
}

function canonicalOrigin(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) return null;
    try {
        const url = new URL(raw);
        const authority = (raw.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i) || [])[1] || '';
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || authority.includes('@')) return null;
        if (url.port && !['80', '443'].includes(url.port)) return null;
        if (url.port === '80' && url.protocol !== 'http:' || url.port === '443' && url.protocol !== 'https:') return null;
        if (isBlockedHost(url.hostname)) return null;
        return url.origin;
    } catch { return null; }
}

function detectContentType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buffer[0] === 0 && buffer[1] === 0 && [1, 2].includes(buffer[2]) && buffer[3] === 0) return 'image/x-icon';
    if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(buffer.toString('ascii', 8, 12))) return 'image/avif';
    if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
    const sample = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('utf8').trimStart();
    if (/^<svg(?:\s|>)/i.test(sample) || /^<\?xml[\s\S]*?<svg(?:\s|>)/i.test(sample)) return 'image/svg+xml';
    return null;
}

const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

function pngCrc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function validPng(buffer) {
    if (buffer.length < 57) return false;
    let offset = 8;
    let header;
    let palette = false;
    let sawData = false;
    let dataEnded = false;
    let ended = false;
    const compressed = [];
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        if (length > buffer.length - offset - 12) return false;
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const bodyStart = offset + 8;
        const bodyEnd = bodyStart + length;
        if (pngCrc32(buffer.subarray(offset + 4, bodyEnd)) !== buffer.readUInt32BE(bodyEnd)) return false;
        if (!header && (type !== 'IHDR' || length !== 13)) return false;
        if (type === 'IHDR') {
            if (header || offset !== 8) return false;
            const width = buffer.readUInt32BE(bodyStart);
            const height = buffer.readUInt32BE(bodyStart + 4);
            const bitDepth = buffer[bodyStart + 8];
            const colorType = buffer[bodyStart + 9];
            const compression = buffer[bodyStart + 10];
            const filter = buffer[bodyStart + 11];
            const interlace = buffer[bodyStart + 12];
            const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
            const validDepth = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })[colorType];
            if (!width || !height || !validDepth?.includes(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) return false;
            header = { width, height, bitDepth, colorType, channels, interlace };
        } else if (type === 'PLTE') {
            if (!length || length % 3 || length > 768) return false;
            palette = true;
        } else if (type === 'IDAT') {
            if (!header || dataEnded) return false;
            sawData = true;
            compressed.push(buffer.subarray(bodyStart, bodyEnd));
        } else if (sawData && type !== 'IEND') dataEnded = true;
        if (type === 'IEND') {
            if (length !== 0 || !sawData) return false;
            ended = true;
            offset = bodyEnd + 4;
            break;
        }
        offset = bodyEnd + 4;
    }
    if (!ended || !header || (header.colorType === 3 && !palette)) return false;
    const passes = header.interlace
        ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
        : [[0, 0, 1, 1]];
    const rows = [];
    let decodedLength = 0;
    for (const [x, y, dx, dy] of passes) {
        const width = header.width <= x ? 0 : Math.ceil((header.width - x) / dx);
        const height = header.height <= y ? 0 : Math.ceil((header.height - y) / dy);
        if (!width || !height) continue;
        const rowBytes = Math.ceil(width * header.channels * header.bitDepth / 8);
        rows.push({ height, rowBytes });
        decodedLength += height * (rowBytes + 1);
        if (decodedLength > MAX_DECODED_IMAGE_BYTES) return false;
    }
    let inflated;
    try { inflated = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: MAX_DECODED_IMAGE_BYTES }); }
    catch { return false; }
    if (inflated.length !== decodedLength) return false;
    let cursor = 0;
    for (const { height, rowBytes } of rows) {
        for (let row = 0; row < height; row++) {
            if (inflated[cursor] > 4) return false;
            cursor += rowBytes + 1;
        }
    }
    return true;
}

function validJpeg(buffer) {
    if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) return false;
    let offset = 2;
    let frame = false;
    let scan = false;
    while (offset + 4 < buffer.length - 2) {
        if (buffer[offset++] !== 0xff) return false;
        while (buffer[offset] === 0xff) offset++;
        const marker = buffer[offset++];
        const length = buffer.readUInt16BE(offset);
        if (length < 2 || offset + length > buffer.length) return false;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
            frame = length >= 8 && buffer.readUInt16BE(offset + 3) > 0 && buffer.readUInt16BE(offset + 5) > 0;
        }
        if (marker === 0xda) { scan = length >= 6; break; }
        offset += length;
    }
    return frame && scan;
}

function skipGifSubBlocks(buffer, offset) {
    while (offset < buffer.length) {
        const length = buffer[offset++];
        if (length === 0) return offset;
        if (offset + length > buffer.length) return -1;
        offset += length;
    }
    return -1;
}

function validGif(buffer) {
    if (buffer.length < 14 || !/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)) || !buffer.readUInt16LE(6) || !buffer.readUInt16LE(8)) return false;
    let offset = 13;
    const screen = buffer[10];
    if (screen & 0x80) offset += 3 * (1 << ((screen & 7) + 1));
    let frame = false;
    while (offset < buffer.length) {
        const marker = buffer[offset++];
        if (marker === 0x3b) return frame && offset === buffer.length;
        if (marker === 0x21) {
            if (offset >= buffer.length) return false;
            offset = skipGifSubBlocks(buffer, offset + 1);
        } else if (marker === 0x2c) {
            if (offset + 9 > buffer.length) return false;
            const local = buffer[offset + 8];
            offset += 9;
            if (local & 0x80) offset += 3 * (1 << ((local & 7) + 1));
            if (offset >= buffer.length) return false;
            offset = skipGifSubBlocks(buffer, offset + 1);
            frame = true;
        } else return false;
        if (offset < 0) return false;
    }
    return false;
}

function validWebp(buffer) {
    if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return false;
    const end = buffer.readUInt32LE(4) + 8;
    if (end > buffer.length || end < 20) return false;
    let offset = 12;
    let image = false;
    while (offset + 8 <= end) {
        const type = buffer.toString('ascii', offset, offset + 4);
        const length = buffer.readUInt32LE(offset + 4);
        if (length > end - offset - 8) return false;
        if (type === 'VP8 ' || type === 'VP8L') image = length > 0;
        offset += 8 + length + (length & 1);
    }
    return image && offset === end;
}

function validIconDirectory(buffer) {
    if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0 || ![1, 2].includes(buffer.readUInt16LE(2))) return false;
    const count = buffer.readUInt16LE(4);
    const directoryEnd = 6 + count * 16;
    if (!count || directoryEnd > buffer.length) return false;
    for (let index = 0; index < count; index++) {
        const entry = 6 + index * 16;
        const bytes = buffer.readUInt32LE(entry + 8);
        const offset = buffer.readUInt32LE(entry + 12);
        if (bytes && offset >= directoryEnd && offset + bytes <= buffer.length) return true;
    }
    return false;
}

function validBmp(buffer) {
    if (buffer.length < 26 || buffer.toString('ascii', 0, 2) !== 'BM') return false;
    const fileSize = buffer.readUInt32LE(2);
    const pixelOffset = buffer.readUInt32LE(10);
    const headerSize = buffer.readUInt32LE(14);
    if (fileSize > buffer.length || fileSize < 26 || pixelOffset < 14 + headerSize || pixelOffset >= fileSize || 14 + headerSize > fileSize) return false;
    if (headerSize === 12) return buffer.readUInt16LE(18) > 0 && buffer.readUInt16LE(20) > 0;
    if (headerSize < 40) return false;
    return buffer.readInt32LE(18) !== 0 && buffer.readInt32LE(22) !== 0;
}

function validAvif(buffer) {
    let offset = 0;
    let brand = false;
    let metadata = false;
    let media = false;
    while (offset + 8 <= buffer.length) {
        let size = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > buffer.length) return false;
            const large = buffer.readBigUInt64BE(offset + 8);
            if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
            size = Number(large);
            headerSize = 16;
        } else if (size === 0) size = buffer.length - offset;
        if (size < headerSize || offset + size > buffer.length) return false;
        if (type === 'ftyp') {
            if (size < headerSize + 8) return false;
            const brands = buffer.toString('ascii', offset + headerSize, offset + size);
            brand = brands.includes('avif') || brands.includes('avis');
        }
        if (type === 'meta' && size >= headerSize + 4) metadata = true;
        if (type === 'mdat' && size > headerSize) media = true;
        offset += size;
    }
    return offset === buffer.length && brand && metadata && media;
}

// shortcut: structure checks do not decode pixels, upgrade only if browsers reject valid cached sources.
function validImageStructure(buffer, contentType) {
    if (contentType === 'image/png') return validPng(buffer);
    if (contentType === 'image/jpeg') return validJpeg(buffer);
    if (contentType === 'image/gif') return validGif(buffer);
    if (contentType === 'image/webp') return validWebp(buffer);
    if (contentType === 'image/x-icon') return validIconDirectory(buffer);
    if (contentType === 'image/bmp') return validBmp(buffer);
    if (contentType === 'image/avif') return validAvif(buffer);
    if (contentType === 'image/svg+xml') {
        const svg = buffer.toString('utf8');
        return /<svg\b[^>]*>/i.test(svg) && (/<\/svg\s*>/i.test(svg) || /<svg\b[^>]*\/>/i.test(svg));
    }
    return false;
}

function decodeHtmlEntities(value) {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    return String(value).replace(/&(#(?:x[\da-f]+|\d+)|amp|quot|apos|lt|gt);/gi, (match, entity) => {
        if (entity[0] !== '#') return named[entity.toLowerCase()] || match;
        const hexadecimal = entity[1]?.toLowerCase() === 'x';
        const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
            ? String.fromCodePoint(codePoint) : '\uFFFD';
    });
}

function iconScore(href, sizes = '', type = '', apple = false) {
    const svg = /\.svg(?:[?#]|$)/i.test(href) || /^image\/svg\+xml\b/i.test(type);
    const usefulSize = /(?:^|\s)any(?:\s|$)/i.test(sizes) || String(sizes).split(/\s+/).some(size => {
        const dimensions = /^(\d+)x(\d+)$/i.exec(size);
        return dimensions && [Number(dimensions[1]), Number(dimensions[2])].every(value => value >= 32 && value <= 128);
    });
    return (apple ? 10 : 20) + (usefulSize ? 5 : 0) + (svg ? 3 : 0);
}

function parseAttributes(tag) {
    const attrs = {};
    const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let match;
    while ((match = re.exec(tag))) attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
    return attrs;
}

function extractPageMetadata(html) {
    const head = String(html || '').slice(0, HTML_READ_LIMIT).split(/<\/head\s*>/i, 1)[0];
    const base = (head.match(/<base\b[^>]*>/i) || [])[0];
    const baseHref = base ? parseAttributes(base).href : null;
    const icons = [];
    let manifest = null;
    for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
        const attrs = parseAttributes(match[0]);
        const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
        if (rel.includes('manifest') && attrs.href && !manifest) manifest = attrs.href;
        const apple = rel.some(item => item.startsWith('apple-touch-icon'));
        if (attrs.href && (rel.includes('icon') || apple)) {
            icons.push({ href: attrs.href, sizes: attrs.sizes || '', type: attrs.type || '', source: 'html', score: iconScore(attrs.href, attrs.sizes, attrs.type, apple) });
        }
    }
    icons.sort((a, b) => b.score - a.score);
    return { baseHref, icons: icons.slice(0, MAX_ICON_CANDIDATES), manifest };
}

function extractIconLinks(html) {
    return extractPageMetadata(html).icons.map(icon => icon.href);
}

function dataImage(value) {
    if (typeof value !== 'string' || value.length > MAX_IMAGE_BYTES * 3 + 128) return null;
    const comma = value.indexOf(',');
    if (comma < 0) return null;
    const match = /^data:(image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon))(?:;charset=[^;,]+)?(;base64)?$/i.exec(value.slice(0, comma));
    if (!match) return null;
    try {
        const payload = value.slice(comma + 1);
        if (match[2] && !/^[a-z0-9+/=\s]*$/i.test(payload)) return null;
        const data = match[2]
            ? Buffer.from(payload.replace(/\s/g, ''), 'base64')
            : Buffer.from(decodeURIComponent(payload));
        const contentType = detectContentType(data);
        return data.length > 0 && data.length <= MAX_IMAGE_BYTES && contentType && validImageStructure(data, contentType) ? { data, contentType } : null;
    } catch { return null; }
}

function header(headers, name) {
    return headers?.[name.toLowerCase()] ?? headers?.[name] ?? '';
}

function iconNotModified(icon, headerValue) {
    if (!icon || icon.stale || !headerValue) return false;
    return String(headerValue).split(',').some(tag => {
        const value = tag.trim().replace(/^W\//, '');
        return value === '*' || value === icon.etag;
    });
}

function cancelledRequest() {
    return Object.assign(new Error('icon request was cancelled'), { code: 'client_closed' });
}

function requestOnce(url, address, maxBytes, timeoutMs, signal, truncate) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'https:' ? https : http;
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
        const req = transport.request(parsed, {
            method: 'GET',
            agent: parsed.protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT,
            lookup: createPinnedLookup(address),
            servername: net.isIP(hostname) ? undefined : hostname,
            maxHeaderSize: RESPONSE_HEADER_LIMIT,
            headers: {
                'User-Agent': 'Pabu-Icon/1.0',
                'Accept': 'text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.2',
                'Accept-Encoding': 'identity'
            }
        }, res => {
            const statusCode = res.statusCode || 0;
            const headers = res.headers;
            if ([301, 302, 303, 307, 308].includes(statusCode)) {
                res.destroy();
                return resolve({ statusCode, headers, body: Buffer.alloc(0), location: headers.location, finalUrl: url });
            }
            if (statusCode === 429 || statusCode === 503) {
                res.destroy();
                return resolve({ statusCode, headers, body: Buffer.alloc(0), finalUrl: url });
            }
            const chunks = [];
            let bytes = 0;
            let settled = false;
            let overflow = false;
            res.on('data', chunk => {
                if (settled || overflow) return;
                if (bytes + chunk.length > maxBytes && truncate) {
                    const remaining = maxBytes - bytes;
                    if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
                    settled = true;
                    resolve({ statusCode, headers, body: Buffer.concat(chunks), finalUrl: url });
                    req.destroy();
                    return;
                }
                bytes += chunk.length;
                if (bytes > maxBytes) {
                    overflow = true;
                    req.destroy(new Error('response body exceeds limit'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => { if (!settled) resolve({ statusCode, headers, body: Buffer.concat(chunks), finalUrl: url }); });
            res.on('error', reject);
        });
        req.setTimeout(Math.max(1, timeoutMs), () => req.destroy(new Error('request timed out')));
        const abort = () => req.destroy(signal.reason || new Error('request aborted'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        req.on('error', reject);
        req.on('close', () => signal?.removeEventListener('abort', abort));
        req.end();
    });
}

class IconService {
    constructor(options = {}) {
        this.cache = new Map();
        this.cacheBytes = 0;
        this.negativeCache = new Map();
        this.inFlight = new Map();
        this.diskWrites = new Set();
        this.queue = [];
        this.activeJobs = 0;
        this.waitingRequests = 0;
        this.maxEntries = options.maxEntries ?? 500;
        this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
        this.maxDiskEntries = options.maxDiskEntries ?? 1000;
        this.maxDiskBytes = options.maxDiskBytes ?? 64 * 1024 * 1024;
        this.maxNegativeEntries = options.maxNegativeEntries ?? 2000;
        this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
        this.ttlMs = options.ttlMs ?? 7 * DAY;
        this.negativeTtlMs = options.negativeTtlMs ?? NEGATIVE_TTL_MS;
        this.refreshCooldownMs = options.refreshCooldownMs ?? REFRESH_COOLDOWN_MS;
        this.maxActiveJobs = options.maxActiveJobs ?? 8;
        this.maxQueuedOrigins = options.maxQueuedOrigins ?? 64;
        this.maxOriginWaiters = options.maxOriginWaiters ?? 128;
        this.maxWaitingRequests = options.maxWaitingRequests ?? 512;
        this.jobBudgetMs = options.jobBudgetMs ?? JOB_BUDGET_MS;
        this.queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
        this.requestTimeoutMs = Math.min(MAX_REQUEST_MS, Math.max(1, options.requestTimeoutMs ?? MAX_REQUEST_MS));
        this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
        this.legacyCacheFile = options.legacyCacheFile === false ? null : options.legacyCacheFile ?? path.join(process.cwd(), '.icon-cache.json');
        this.maxLegacyCacheBytes = options.maxLegacyCacheBytes ?? this.maxDiskBytes * 1.5 + 1024 * 1024;
        this.random = options.random ?? Math.random;
        this.lookup = options.lookup ?? ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
        this.requestImpl = options.request ?? requestOnce;
        this.fallbackProviders = new Set(String(options.fallbackProviders ?? process.env.PABU_ICON_FALLBACK_PROVIDERS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => ['google', 'duckduckgo'].includes(x)));
        this.requestBudgets = new Map();
        this.lastRefresh = new Map();
        this.maxBudgetIps = options.maxBudgetIps ?? 20000;
        this.maxRefreshKeys = options.maxRefreshKeys ?? 2000;
    }

    validateUrl(raw) {
        const origin = canonicalOrigin(raw);
        return origin ? new URL(raw) : null;
    }

    canonicalOrigin(raw) { return canonicalOrigin(raw); }

    checkRequestBudget(ip, raw, now = Date.now()) {
        const origin = canonicalOrigin(raw);
        if (!origin) return { allowed: false, status: 400 };
        let record = this.requestBudgets.get(ip);
        if (!record || now - record.start >= 60000) record = { start: now, newOrigins: new Set(), cached: 0 };
        const negative = this.negativeCache.get(origin);
        const known = this.cache.has(origin) || (negative?.nextRetryAt || 0) > now;
        if (negative) negative.lastUsedAt = now;
        if (known) {
            if (record.cached >= 600) return { allowed: false, status: 429 };
            record.cached++;
        } else {
            if (!record.newOrigins.has(origin) && record.newOrigins.size >= 60) return { allowed: false, status: 429 };
            record.newOrigins.add(origin);
        }
        if (!this.requestBudgets.has(ip) && this.requestBudgets.size >= this.maxBudgetIps) this.requestBudgets.delete(this.requestBudgets.keys().next().value);
        this.requestBudgets.set(ip, record);
        return { allowed: true, origin, cached: known };
    }

    sweep(now = Date.now()) {
        for (const [ip, record] of this.requestBudgets) if (now - record.start >= 60000) this.requestBudgets.delete(ip);
        for (const [origin, record] of this.negativeCache) if (now - (record.lastUsedAt || 0) > 7 * DAY) this.negativeCache.delete(origin);
        for (const [origin, refreshedAt] of this.lastRefresh) if (now - refreshedAt > Math.max(this.refreshCooldownMs, 60000)) this.lastRefresh.delete(origin);
    }

    _touch(key, entry) {
        this.cache.delete(key);
        this.cache.set(key, entry);
    }

    _setCache(key, entry) {
        if (!entry?.data || entry.data.length > this.maxImageBytes || entry.data.length > this.maxBytes) return;
        const old = this.cache.get(key);
        if (old) this.cacheBytes -= old.data.length;
        this.cache.delete(key);
        while (this.cache.size >= this.maxEntries || this.cacheBytes + entry.data.length > this.maxBytes) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cacheBytes -= this.cache.get(oldest).data.length;
            this.cache.delete(oldest);
        }
        this.cache.set(key, entry);
        this.cacheBytes += entry.data.length;
    }

    _setNegative(key, retryAfterMs = 0, now = Date.now()) {
        const previous = this.negativeCache.get(key);
        const failureCount = (previous?.failureCount || 0) + 1;
        const delays = [this.negativeTtlMs, 30 * 60 * 1000, 2 * 60 * 60 * 1000, DAY];
        const upstreamMinimum = Math.min(retryAfterMs, DAY);
        const base = Math.max(delays[Math.min(failureCount - 1, delays.length - 1)], upstreamMinimum);
        const jittered = Math.max(upstreamMinimum, Math.round(base * (0.9 + this.random() * 0.2)));
        this.negativeCache.delete(key);
        this.negativeCache.set(key, { nextRetryAt: now + jittered, failureCount, lastUsedAt: now });
        while (this.negativeCache.size > this.maxNegativeEntries) this.negativeCache.delete(this.negativeCache.keys().next().value);
    }

    _diskPath(origin) { return path.join(this.cacheDir, `${crypto.createHash('sha256').update(origin).digest('hex')}.json`); }

    async _loadDisk(origin) {
        try {
            await this.diskReady;
            const filename = this._diskPath(origin);
            const stat = await fs.stat(filename);
            if (!stat.isFile() || stat.size > this.maxImageBytes * 1.5 + 4096) return null;
            const record = JSON.parse(await fs.readFile(filename, 'utf8'));
            if (record.origin !== origin || !Number.isFinite(record.validatedAt) || typeof record.data !== 'string' || record.data.length > this.maxImageBytes * 1.5) return null;
            const data = Buffer.from(record.data, 'base64');
            const contentType = detectContentType(data);
            if (!data.length || data.length > this.maxImageBytes || !contentType || contentType !== record.contentType || !validImageStructure(data, contentType)) return null;
            const entry = { data, contentType, source: record.source || 'legacy', validatedAt: record.validatedAt, etag: this._etag(data) };
            this._setCache(origin, entry);
            const accessedAt = new Date();
            fs.utimes(filename, accessedAt, accessedAt).catch(() => {});
            return entry;
        } catch { return null; }
    }

    async _writeDisk(origin, entry) {
        const filename = this._diskPath(origin);
        const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            await this.diskReady;
            await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
            const payload = JSON.stringify({ origin, validatedAt: entry.validatedAt, contentType: entry.contentType, source: entry.source || 'unknown', etag: entry.etag, data: entry.data.toString('base64') });
            await fs.writeFile(temp, payload, { mode: 0o600, flag: 'wx' });
            await fs.rename(temp, filename);
            await this._cleanDisk();
        } catch {
            await fs.rm(temp, { force: true }).catch(() => {});
        }
    }

    async _cleanDisk({ removeTemps = false } = {}) {
        const entries = [];
        let totalBytes = 0;
        try {
            if (removeTemps) await this._migrateLegacyCache();
            for (const name of await fs.readdir(this.cacheDir)) {
                if (removeTemps && /^[a-f0-9]{64}\.json\.\d+\.[a-f0-9]+\.tmp$/.test(name)) {
                    await fs.rm(path.join(this.cacheDir, name), { force: true }).catch(() => {});
                    continue;
                }
                if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
                const file = path.join(this.cacheDir, name);
                const stat = await fs.stat(file).catch(() => null);
                if (!stat?.isFile()) continue;
                totalBytes += stat.size;
                entries.push({ file, size: stat.size, mtime: stat.mtimeMs });
            }
            entries.sort((a, b) => a.mtime - b.mtime);
            while (entries.length > this.maxDiskEntries || totalBytes > this.maxDiskBytes) {
                const removed = entries.shift();
                if (!removed) break;
                await fs.rm(removed.file, { force: true }).catch(() => {});
                totalBytes -= removed.size;
            }
        } catch { /* Disk cache is an optimization and must never prevent service startup. */ }
    }

    async _migrateLegacyCache() {
        if (!this.legacyCacheFile) return;
        let entries;
        try {
            const stat = await fs.stat(this.legacyCacheFile);
            if (!stat.isFile() || stat.size > this.maxLegacyCacheBytes) return;
            const parsed = JSON.parse(await fs.readFile(this.legacyCacheFile, 'utf8'));
            entries = Array.isArray(parsed) ? parsed : Object.entries(parsed);
            if (!Array.isArray(entries) || entries.length > this.maxDiskEntries) return;
        } catch { return; }
        await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 }).catch(() => {});
        const migrated = new Set();
        let failed = false;
        for (const pair of entries) {
            if (!Array.isArray(pair) || pair.length !== 2) continue;
            const [rawOrigin, record] = pair;
            const origin = canonicalOrigin(rawOrigin);
            if (!origin || migrated.has(origin) || typeof record?.data !== 'string' || record.data.length > this.maxImageBytes * 1.5) continue;
            const data = Buffer.from(record.data, 'base64');
            const contentType = detectContentType(data);
            if (!data.length || data.length > this.maxImageBytes || !contentType || contentType !== record.contentType || !validImageStructure(data, contentType)) continue;
            const filename = this._diskPath(origin);
            try {
                const existing = JSON.parse(await fs.readFile(filename, 'utf8'));
                const existingData = typeof existing.data === 'string' && existing.data.length <= this.maxImageBytes * 1.5 ? Buffer.from(existing.data, 'base64') : null;
                if (existing.origin === origin && Number.isFinite(existing.validatedAt) && existingData?.length && detectContentType(existingData) === existing.contentType && validImageStructure(existingData, existing.contentType)) {
                    migrated.add(origin);
                    continue;
                }
            } catch {}
            const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
            try {
                const payload = JSON.stringify({ origin, validatedAt: 0, contentType, source: 'legacy', etag: this._etag(data), data: data.toString('base64') });
                await fs.writeFile(temp, payload, { mode: 0o600, flag: 'wx' });
                await fs.rename(temp, filename);
                migrated.add(origin);
            } catch {
                failed = true;
                await fs.rm(temp, { force: true }).catch(() => {});
            }
        }
        if (migrated.size && !failed) await fs.rm(this.legacyCacheFile, { force: true }).catch(() => {});
    }

    _etag(data) { return `"${crypto.createHash('sha256').update(data).digest('hex')}"`; }

    _view(entry, now = Date.now()) {
        return { ...entry, stale: now - entry.validatedAt >= this.ttlMs };
    }

    async getIcon(raw, { signal } = {}) {
        const origin = canonicalOrigin(raw);
        if (!origin) return null;
        if (signal?.aborted) throw cancelledRequest();
        const now = Date.now();
        const cached = this.cache.get(origin);
        if (cached) {
            this._touch(origin, cached);
            if (now - cached.validatedAt < this.ttlMs) return this._view(cached, now);
            const negativeUntil = this.negativeCache.get(origin)?.nextRetryAt || 0;
            if (negativeUntil) this.negativeCache.get(origin).lastUsedAt = now;
            if (negativeUntil <= now) {
                try { this._ensureJob(origin, cached).background = true; } catch { /* Serve stale data while the bounded queue is full. */ }
            }
            return this._view(cached, now);
        }
        const negativeUntil = this.negativeCache.get(origin)?.nextRetryAt || 0;
        if (negativeUntil) this.negativeCache.get(origin).lastUsedAt = now;
        if (negativeUntil > now) return null;
        const result = await this._joinJob(origin, signal);
        return result?.entry ? this._view(result.entry) : null;
    }

    async refreshIcon(raw, options = {}) {
        const origin = canonicalOrigin(raw);
        if (!origin) return { status: 'invalid', icon: null };
        if (options.signal?.aborted) return { status: 'cancelled', icon: null };
        const now = Date.now();
        const old = this.cache.get(origin) || null;
        const currentJob = this.inFlight.get(origin);
        const joiningJob = !!currentJob && currentJob.state !== 'done';
        const negative = this.negativeCache.get(origin);
        const negativeUntil = negative?.nextRetryAt || 0;
        if (negative) negative.lastUsedAt = now;
        if (!joiningJob && negativeUntil > now) return { status: 'cooldown', icon: old ? this._view(old) : null, retryAfterMs: negativeUntil - now };
        const last = this.lastRefresh.get(origin) || 0;
        if (!joiningJob && last && now - last < this.refreshCooldownMs) return { status: 'cooldown', icon: old ? this._view(old) : null, retryAfterMs: this.refreshCooldownMs - (now - last) };
        if (this.waitingRequests >= this.maxWaitingRequests || (this.inFlight.get(origin)?.waiters || 0) >= this.maxOriginWaiters) return { status: 'waiters_full', icon: old ? this._view(old) : null };
        let job;
        try { job = this._ensureJob(origin, old, true); }
        catch (error) { return { status: error.code || 'unavailable', icon: old ? this._view(old) : null }; }
        if (!last || now - last >= this.refreshCooldownMs) {
            this.lastRefresh.delete(origin);
            this.lastRefresh.set(origin, now);
        }
        while (this.lastRefresh.size > this.maxRefreshKeys) this.lastRefresh.delete(this.lastRefresh.keys().next().value);
        const waitMs = Math.min(options.waitMs ?? this.jobBudgetMs, this.jobBudgetMs);
        job.waiters++;
        this.waitingRequests++;
        let result;
        try { result = await this._waitForJob(job, waitMs, false, options.signal); }
        catch (error) {
            this._leaveJob(job, error.code === 'client_closed');
            if (error.code === 'client_closed') {
                if (!job.waiters && !job.background && (job.state === 'done' || job.controller?.signal.aborted) && this.lastRefresh.get(origin) === now) this.lastRefresh.delete(origin);
                return { status: 'cancelled', icon: old ? this._view(old) : null };
            }
            return { status: error.code === 'queue_timeout' ? 'queue_timeout' : 'timeout', icon: old ? this._view(old) : null };
        }
        this._leaveJob(job);
        if (result?.failure === 'queue_timeout') return { status: 'queue_timeout', icon: old ? this._view(old) : null };
        if (result?.entry) return { status: 'ok', icon: this._view(result.entry) };
        if (result?.failure === 'timeout') return { status: 'timeout', icon: old ? this._view(old) : null };
        return { status: 'failed', icon: old ? this._view(old) : null };
    }

    _ensureJob(origin, oldEntry, forceRefresh = false) {
        const existing = this.inFlight.get(origin);
        if (existing && existing.state !== 'done') {
            existing.forceRefresh ||= forceRefresh;
            return existing;
        }
        if (existing) this.inFlight.delete(origin);
        if (this.queue.length >= this.maxQueuedOrigins && this.activeJobs >= this.maxActiveJobs) {
            const error = new Error('icon queue is full'); error.code = 'queue_full'; throw error;
        }
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        let resolveStale;
        const stalePromise = new Promise(r => { resolveStale = r; });
        const job = { origin, oldEntry, forceRefresh, background: false, promise, resolve, stalePromise, resolveStale, staleReady: false, waiters: 0, startedAt: 0, queuedAt: Date.now(), state: 'queued' };
        this.inFlight.set(origin, job);
        this.queue.push(job);
        job.queueTimer = setTimeout(() => {
            if (job.state !== 'queued') return;
            this.queue = this.queue.filter(item => item !== job);
            job.state = 'done';
            if (this.inFlight.get(origin) === job) this.inFlight.delete(origin);
            job.resolve({ entry: null, failure: 'queue_timeout' });
        }, this.queueWaitMs).unref();
        this._drainQueue();
        return job;
    }

    _drainQueue() {
        while (this.activeJobs < this.maxActiveJobs && this.queue.length) {
            const job = this.queue.shift();
            clearTimeout(job.queueTimer);
            job.state = 'active';
            job.startedAt = Date.now();
            this.activeJobs++;
            this._runJob(job).then(result => { job.state = 'done'; job.resolve(result); }, () => { job.state = 'done'; job.resolve({ entry: null }); }).finally(() => {
                this.activeJobs--;
                if (this.inFlight.get(job.origin) === job) this.inFlight.delete(job.origin);
                this._drainQueue();
            });
        }
    }

    async _joinJob(origin, signal) {
        if (signal?.aborted) throw cancelledRequest();
        let job = this.inFlight.get(origin);
        if (this.waitingRequests >= this.maxWaitingRequests || (job?.waiters || 0) >= this.maxOriginWaiters) {
            const error = new Error('icon waiter limit reached'); error.code = 'waiters_full'; throw error;
        }
        if (!job) job = this._ensureJob(origin, null);
        job.waiters++;
        this.waitingRequests++;
        let result;
        try { result = await this._waitForJob(job, this.jobBudgetMs, true, signal); }
        catch (error) {
            this._leaveJob(job);
            throw error;
        }
        this._leaveJob(job);
        if (result?.failure === 'queue_timeout') {
            const error = new Error('icon queue wait timed out'); error.code = 'queue_timeout'; throw error;
        }
        return result;
    }

    _leaveJob(job, cancelActive = true) {
        job.waiters = Math.max(0, job.waiters - 1);
        this.waitingRequests = Math.max(0, this.waitingRequests - 1);
        if (job.waiters || job.background || job.state === 'done') return;
        if (job.state === 'queued') {
            this.queue = this.queue.filter(item => item !== job);
            clearTimeout(job.queueTimer);
            job.state = 'done';
            if (this.inFlight.get(job.origin) === job) this.inFlight.delete(job.origin);
            job.resolve({ entry: null, failure: 'cancelled' });
        } else if (cancelActive) job.controller?.abort(cancelledRequest());
    }

    async _waitForJob(job, timeoutMs, returnStale = false, signal) {
        if (signal?.aborted) throw cancelledRequest();
        if (returnStale && job.staleReady) return job.staleResult;
        const deadline = Date.now() + timeoutMs;
        const queueDeadline = job.queuedAt + this.queueWaitMs;
        const timeout = Symbol('timeout');
        while (true) {
            const now = Date.now();
            const waitUntil = job.state === 'queued' ? Math.min(deadline, queueDeadline) : deadline;
            if (waitUntil <= now) {
                const error = new Error('icon job wait timed out');
                error.code = job.state === 'queued' ? 'queue_timeout' : 'job_timeout';
                throw error;
            }
            let timer;
            let onAbort;
            const promises = [job.promise];
            if (returnStale && !job.staleReady) promises.push(job.stalePromise);
            const timeoutPromise = new Promise(resolve => { timer = setTimeout(() => resolve(timeout), waitUntil - now); });
            const abortPromise = signal ? new Promise((_, reject) => {
                onAbort = () => reject(cancelledRequest());
                signal.addEventListener('abort', onAbort, { once: true });
            }) : null;
            let result;
            try { result = await Promise.race([...promises, timeoutPromise, ...(abortPromise ? [abortPromise] : [])]); }
            finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
            if (result !== timeout) return result;
            if (job.state === 'queued' && Date.now() >= queueDeadline) {
                const error = new Error('icon queue wait timed out'); error.code = 'queue_timeout'; throw error;
            }
            if (Date.now() >= deadline) {
                const error = new Error('icon job wait timed out'); error.code = 'job_timeout'; throw error;
            }
        }
    }

    async _runJob(job) {
        const controller = new AbortController();
        job.controller = controller;
        const deadline = job.queuedAt + this.jobBudgetMs;
        const timer = setTimeout(() => controller.abort(new Error('icon job budget exceeded')), Math.max(1, deadline - Date.now()));
        let old = job.oldEntry;
        try {
            if (!old) old = await this._loadDisk(job.origin);
            if (Date.now() >= deadline) throw new Error('icon job deadline exceeded');
            if (old && !job.forceRefresh && Date.now() - old.validatedAt < this.ttlMs) return { entry: old };
            if (old && Date.now() - old.validatedAt >= this.ttlMs) {
                job.background = true;
                job.staleReady = true;
                job.staleResult = { entry: old, staleDisk: true };
                job.resolveStale(job.staleResult);
            }
            const entry = await this._discover(job.origin, deadline, controller.signal);
            const finishedAt = Date.now();
            if (controller.signal.aborted || finishedAt > deadline || (!entry && finishedAt >= deadline)) throw new Error('icon job deadline exceeded');
            if (!entry) throw new Error('icon not found');
            entry.validatedAt = Date.now();
            entry.etag = this._etag(entry.data);
            this._setCache(job.origin, entry);
            this.negativeCache.delete(job.origin);
            const write = this._writeDisk(job.origin, entry);
            this.diskWrites.add(write);
            write.finally(() => this.diskWrites.delete(write));
            return { entry };
        } catch (error) {
            if (controller.signal.aborted && controller.signal.reason?.code === 'client_closed') return { entry: null, oldEntry: old || null, failure: 'cancelled' };
            const timeout = controller.signal.aborted || /timed out|deadline exceeded/i.test(error.message);
            if (!timeout) this._setNegative(job.origin, error.retryAfterMs || 0);
            return { entry: null, oldEntry: old || null, failure: timeout ? 'timeout' : 'failed' };
        } finally { clearTimeout(timer); }
    }

    async _resolvePublicAddress(url, deadline, signal) {
        const parsed = new URL(url);
        if (!canonicalOrigin(url)) throw new Error('blocked destination');
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(host)) {
            if (!isPublicAddress(host)) throw new Error('private address blocked');
            return host;
        }
        let timeout;
        let abort;
        let results;
        try {
            results = await Promise.race([
                this.lookup(host),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('DNS lookup timed out')), Math.max(1, Math.min(this.requestTimeoutMs, deadline - Date.now())));
                    abort = () => reject(signal.reason || new Error('DNS lookup aborted'));
                    signal.addEventListener('abort', abort, { once: true });
                })
            ]);
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
        }
        const addresses = Array.isArray(results) ? results : [results];
        if (!addresses.length || addresses.some(item => !item?.address || !isPublicAddress(item.address))) throw new Error('unsafe DNS answer');
        return addresses[0].address;
    }

    async _fetchBounded(raw, maxBytes, deadline, signal, truncate = false) {
        let url = raw;
        for (let redirects = 0; ; redirects++) {
            if (signal?.aborted) throw signal.reason || new Error('request aborted');
            if (Date.now() >= deadline) throw new Error('job deadline exceeded');
            const parsed = new URL(url);
            if (!canonicalOrigin(url)) throw new Error('blocked redirect');
            if (signal?.aborted) throw signal.reason || new Error('request aborted');
            const address = await this._resolvePublicAddress(url, deadline, signal);
            if (!address) throw new Error('unsafe DNS answer');
            const timeout = Math.min(this.requestTimeoutMs, deadline - Date.now());
            if (timeout <= 0) throw new Error('request budget exceeded');
            const requestController = new AbortController();
            const abort = () => requestController.abort(signal.reason || new Error('request aborted'));
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            let timer;
            let response;
            try {
                response = await Promise.race([
                    this.requestImpl(url, address, maxBytes, timeout, requestController.signal, truncate),
                    new Promise((_, reject) => { timer = setTimeout(() => {
                        const error = new Error('request timed out');
                        requestController.abort(error);
                        reject(error);
                    }, timeout); })
                ]);
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
            }
            if (response.statusCode === 429 || response.statusCode === 503) {
                const retryAfter = header(response.headers, 'retry-after');
                const seconds = Number(retryAfter);
                const retryAt = Date.parse(retryAfter);
                const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
                const error = new Error('upstream requested backoff');
                error.retryAfterMs = retryAfterMs;
                throw error;
            }
            if (![301, 302, 303, 307, 308].includes(response.statusCode)) {
                if (response.body.length > maxBytes) {
                    if (truncate) response.body = response.body.subarray(0, maxBytes);
                    else throw new Error('response too large');
                }
                return response;
            }
            if (redirects >= MAX_REDIRECTS || !response.location) throw new Error('too many redirects');
            url = new URL(response.location, response.finalUrl || parsed.href).href;
        }
    }

    _imageFromResponse(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) return null;
        const data = response.body;
        const contentType = detectContentType(data);
        if (!contentType || !data.length || data.length > this.maxImageBytes || !validImageStructure(data, contentType)) return null;
        return { data, contentType };
    }

    async _discover(origin, deadline, signal) {
        const candidateDeadline = deadline - (this.fallbackProviders.size ? THIRD_PARTY_RESERVE_MS : 0);
        let page;
        try { page = await this._fetchBounded(`${origin}/`, HTML_READ_LIMIT, candidateDeadline, signal, true); }
        catch (error) { if (error.retryAfterMs !== undefined) throw error; page = null; }
        const declared = [];
        let manifest = null;
        const readablePage = page && (page.statusCode >= 200 && page.statusCode < 300 || page.statusCode === 403) && /^text\/(?:html|xhtml)|application\/(?:xhtml\+xml|xml)/i.test(String(header(page.headers, 'content-type')));
        if (readablePage) {
            const metadata = extractPageMetadata(page.body.toString('utf8'));
            const pageUrl = page.finalUrl || `${origin}/`;
            let baseUrl = pageUrl;
            if (metadata.baseHref) {
                try { baseUrl = new URL(metadata.baseHref, pageUrl).href; } catch {}
            }
            for (const icon of metadata.icons) {
                try { declared.push({ url: new URL(icon.href, baseUrl).href, source: 'html', score: icon.score }); } catch {}
            }
            if (metadata.manifest) {
                try { manifest = new URL(metadata.manifest, baseUrl).href; } catch {}
            }
            if (manifest) {
                let manifestRes;
                try { manifestRes = await this._fetchBounded(manifest, MANIFEST_READ_LIMIT, candidateDeadline, signal, true); }
                catch (error) { if (error.retryAfterMs !== undefined) throw error; }
                if (manifestRes?.statusCode >= 200 && manifestRes.statusCode < 300) {
                    try {
                        const data = JSON.parse(manifestRes.body.toString('utf8'));
                        if (Array.isArray(data.icons)) for (const item of data.icons.slice(0, 32)) {
                            if (typeof item.src !== 'string') continue;
                            const url = new URL(item.src, manifestRes.finalUrl || manifest).href;
                            declared.push({ url, source: 'manifest', score: iconScore(url, item.sizes || '', item.type || '') });
                        }
                    } catch {}
                }
            }
        }
        const candidates = [...declared.sort((a, b) => b.score - a.score).slice(0, MAX_DECLARED_CANDIDATES),
            ...['/favicon.ico', '/favicon.png', '/apple-touch-icon.png'].map(pathname => ({ url: new URL(pathname, origin).href, source: 'standard' }))];
        const seen = new Set();
        for (const candidate of candidates) {
            if (seen.has(candidate.url) || Date.now() >= candidateDeadline || seen.size >= MAX_ICON_CANDIDATES) continue;
            seen.add(candidate.url);
            const data = dataImage(candidate.url);
            if (data) return { ...data, source: candidate.source };
            let response;
            try { response = await this._fetchBounded(candidate.url, this.maxImageBytes, candidateDeadline, signal); }
            catch (error) { if (error.retryAfterMs !== undefined) throw error; }
            const image = response && this._imageFromResponse(response);
            if (image) return { ...image, source: candidate.source };
        }
        const providers = [...this.fallbackProviders];
        for (let index = 0; index < providers.length && Date.now() < deadline; index++) {
            const provider = providers[index];
            const providerUrl = target => provider === 'google'
                ? `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(target)}&sz=64`
                : `https://icons.duckduckgo.com/ip3/${new URL(target).hostname}.ico`;
            let response;
            let missingResponse;
            try {
                [response, missingResponse] = await Promise.all([
                    this._fetchBounded(providerUrl(origin), this.maxImageBytes, deadline, signal),
                    this._fetchBounded(providerUrl('https://pabu-icon-missing.invalid'), this.maxImageBytes, deadline, signal)
                ]);
            }
            catch (error) { if (error.retryAfterMs !== undefined) throw error; }
            const image = response && this._imageFromResponse(response);
            if (!image || !missingResponse) continue;
            const defaultImage = this._imageFromResponse(missingResponse);
            const confirmedMissing = [404, 410].includes(missingResponse.statusCode)
                || (missingResponse.statusCode >= 200 && missingResponse.statusCode < 300 && !defaultImage);
            if (!confirmedMissing || (defaultImage && image.data.equals(defaultImage.data))) continue;
            return { ...image, source: provider };
        }
        return null;
    }
}

const defaultIconService = new IconService();
defaultIconService.diskReady = defaultIconService._cleanDisk({ removeTemps: true });

module.exports = { IconService, defaultIconService, extractIconLinks, detectContentType, isPublicAddress, canonicalOrigin, createPinnedLookup, iconNotModified };
