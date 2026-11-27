((root) => {
    'use strict';

    // 文本分享采用 6 位数字短码；散列 ID 与取件证明继续以 26 位 base32 编码。
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
    const SHORT_CODE_LENGTH = 6;
    const SHARE_ID_PATTERN = /^[a-z2-7]{26}$/;
    const SHORT_CODE_PATTERN = /^\d{6}$/;
    // 二期实时传文件的会合码：5 位数字，首位不为 0。
    // 与 6 位文本短码、文件一期单词码都不重叠。
    const RTC_CODE_PATTERN = /^[1-9]\d{4}$/;

    function normalizeShortCode(value) {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim();
        if (!/^[\d\s-]+$/.test(trimmed)) return '';
        return trimmed.replace(/[\s-]/g, '');
    }

    function base32Encode(bytes) {
        let bits = 0;
        let value = 0;
        let output = '';
        for (const byte of bytes) {
            value = (value << 8) | byte;
            bits += 8;
            while (bits >= 5) {
                output += ALPHABET[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }
        if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
        return output;
    }

    function formatShortCode(value) {
        const clean = normalizeShortCode(value);
        if (clean.length !== SHORT_CODE_LENGTH) return clean;
        return clean.slice(0, 3) + ' ' + clean.slice(3);
    }

    function isShortCode(value) {
        return SHORT_CODE_PATTERN.test(normalizeShortCode(value));
    }

    function isShareId(value) {
        return typeof value === 'string' && SHARE_ID_PATTERN.test(value);
    }

    function isRtcCode(value) {
        return typeof value === 'string' && RTC_CODE_PATTERN.test(value);
    }

    function generateShortCode() {
        const range = 1000000;
        const limit = Math.floor(0x100000000 / range) * range;
        const buf = new Uint32Array(1);
        let value;
        do {
            crypto.getRandomValues(buf);
            value = buf[0];
        } while (value >= limit);
        return String(value % range).padStart(SHORT_CODE_LENGTH, '0');
    }

    async function sha256Base32Prefix(text) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
        return base32Encode(digest.slice(0, 16));
    }

    async function deriveId(value) {
        if (!isShortCode(value)) throw new Error('无效的取件码');
        return sha256Base32Prefix('pabu-short-id-v1:' + normalizeShortCode(value));
    }

    // 取件证明：ID 会出现在路径和访问日志里，只有 ID 的人不应该能取走或删除。
    // 证明用短码做域分离散列，服务端存它，取件时必须带上。
    async function deriveProof(value) {
        if (!isShortCode(value)) throw new Error('无效的取件码');
        return sha256Base32Prefix('pabu-short-proof-v1:' + normalizeShortCode(value));
    }

    root.ShareCode = {
        ALPHABET,
        SHORT_CODE_LENGTH,
        SHARE_ID_PATTERN,
        SHORT_CODE_PATTERN,
        RTC_CODE_PATTERN,
        normalizeShortCode,
        base32Encode,
        formatShortCode,
        isShortCode,
        isShareId,
        isRtcCode,
        generateShortCode,
        deriveId,
        deriveProof
    };
})(window);
