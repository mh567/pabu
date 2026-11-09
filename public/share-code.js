((root) => {
    'use strict';

    // 文本分享的取件码就是加密密钥本身。16 字节随机量编码成 26 个 base32
    // 字符，按 5-5-5-5-6 分组，便于复制和口述。
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
    const LOOKUP = Object.create(null);
    for (let index = 0; index < ALPHABET.length; index++) LOOKUP[ALPHABET[index]] = index;

    const CODE_LENGTH = 26;
    const SHARE_ID_PATTERN = /^[a-z2-7]{26}$/;
    // 二期实时传文件的会合码：5 位数字，首位不为 0。
    // 与文本分组密钥、文件一期单词码都不重叠。
    const RTC_CODE_PATTERN = /^[1-9]\d{4}$/;

    function normalizeCode(value) {
        return String(value == null ? '' : value).toLowerCase().replace(/[^a-z2-7]/g, '');
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

    function base32Decode(value) {
        const clean = normalizeCode(value);
        let bits = 0;
        let buffer = 0;
        const bytes = [];
        for (const char of clean) {
            const index = LOOKUP[char];
            if (index === undefined) throw new Error('无效的取件码');
            buffer = (buffer << 5) | index;
            bits += 5;
            if (bits >= 8) {
                bytes.push((buffer >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return new Uint8Array(bytes);
    }

    function groupCode(value) {
        const clean = normalizeCode(value);
        if (clean.length !== CODE_LENGTH) return clean;
        return [clean.slice(0, 5), clean.slice(5, 10), clean.slice(10, 15), clean.slice(15, 20), clean.slice(20)].join('-');
    }

    function isCode(value) {
        return normalizeCode(value).length === CODE_LENGTH;
    }

    function isShareId(value) {
        return typeof value === 'string' && SHARE_ID_PATTERN.test(value);
    }

    function isRtcCode(value) {
        return typeof value === 'string' && RTC_CODE_PATTERN.test(value);
    }

    function generateCode() {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        return groupCode(base32Encode(bytes));
    }

    async function deriveId(value) {
        const key = base32Decode(value);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
        return base32Encode(digest.slice(0, 16));
    }

    // 取件证明：ID 会出现在路径和访问日志里，只有 ID 的人不应该能取走或删除。
    // 证明用密钥做域分离散列，服务端存它，取件时必须带上。
    async function deriveProof(value) {
        const key = base32Decode(value);
        const label = new TextEncoder().encode('pabu-fetch-v1');
        const material = new Uint8Array(label.length + key.length);
        material.set(label);
        material.set(key, label.length);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
        return base32Encode(digest.slice(0, 16));
    }

    function keyBytes(value) {
        return base32Decode(value);
    }

    root.ShareCode = {
        ALPHABET,
        CODE_LENGTH,
        SHARE_ID_PATTERN,
        RTC_CODE_PATTERN,
        normalizeCode,
        base32Encode,
        base32Decode,
        groupCode,
        isCode,
        isShareId,
        isRtcCode,
        generateCode,
        deriveId,
        deriveProof,
        keyBytes
    };
})(window);
