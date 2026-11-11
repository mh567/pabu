'use strict';

/**
 * 网站真实图标抓取与缓存服务。
 *
 * 核心逻辑：
 * 1. 严格校验目标 URL，仅支持 http: 与 https: 协议，拦截私有云元数据与非法主机名。
 * 2. 内存 LRU / Map 缓存，支持 TTL（默认 7 天）与负缓存（失败后短期 5 分钟内不重试）。
 * 3. 针对同一站点 origin 的并发请求复用单个 Promise（singleflight），避免重复向目标站发起抓取。
 * 4. 优先抓取网页 HTML（流式读取前 64 KiB），解析 <link rel="icon"> / <link rel="apple-touch-icon"> 等真实图标链接。
 * 5. 若 HTML 解析无结果或抓取失败，回退尝试 ${origin}/favicon.ico。
 * 6. 校验图标大小（单图上限 2 MiB）与 Content-Type，规范化后返回图片 Buffer。
 */

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_CACHE_MAX = 500;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // 失败缓存 5 分钟
const HTML_READ_LIMIT = 65536; // 64 KiB

// 云元数据与内省保留地址黑名单
const BLOCKED_HOSTS = new Set([
    '169.254.169.254',
    'metadata.google.internal',
    '100.100.100.200',
    'fd00:ec2::254'
]);

function isBlockedHost(hostname) {
    if (!hostname) return true;
    const lower = hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(lower)) return true;
    if (lower.endsWith('.metadata.google.internal')) return true;
    return false;
}

function detectContentType(buffer, declaredType, urlStr) {
    if (buffer.length >= 4) {
        // PNG magic: 89 50 4E 47
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
            return 'image/png';
        }
        // ICO magic: 00 00 01 00 or 00 00 02 00 (cursor)
        if (buffer[0] === 0x00 && buffer[1] === 0x00 && (buffer[2] === 0x01 || buffer[2] === 0x02) && buffer[3] === 0x00) {
            return 'image/x-icon';
        }
        // GIF magic: 47 49 46 38
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
            return 'image/gif';
        }
        // WebP magic: RIFF....WEBP
        if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
            return 'image/webp';
        }
        // JPEG magic: FF D8 FF
        if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
            return 'image/jpeg';
        }
    }
    const sample = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trimStart();
    if (sample.startsWith('<svg') || sample.startsWith('<?xml') && sample.includes('<svg')) {
        return 'image/svg+xml';
    }
    if (declaredType && declaredType.startsWith('image/')) {
        return declaredType.split(';')[0].trim();
    }
    const lowerUrl = (urlStr || '').toLowerCase();
    if (lowerUrl.includes('.svg')) return 'image/svg+xml';
    if (lowerUrl.includes('.png')) return 'image/png';
    if (lowerUrl.includes('.ico')) return 'image/x-icon';
    if (lowerUrl.includes('.webp')) return 'image/webp';
    if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg')) return 'image/jpeg';
    return 'image/x-icon';
}

function extractIconLinks(html) {
    if (!html) return [];
    const linkRegex = /<link\b[^>]*>/gi;
    const links = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
        const tag = match[0];
        const relMatch = tag.match(/\brel\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
        const hrefMatch = tag.match(/\bhref\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
        if (!relMatch || !hrefMatch) continue;
        const rel = (relMatch[1] || relMatch[2] || '').toLowerCase();
        if (!rel.includes('icon') && !rel.includes('apple-touch-icon')) continue;
        const href = (hrefMatch[1] || hrefMatch[2] || '').trim();
        if (!href) continue;
        const isSvg = /\.svg(?:[?#]|$)/i.test(href);
        const isApple = rel.includes('apple-touch-icon');
        links.push({ href, isSvg, isApple });
    }
    // 排序优先级：SVG 最高，其次 apple-touch-icon（通常清晰度高），其余居后
    links.sort((a, b) => {
        const scoreA = (a.isSvg ? 10 : 0) + (a.isApple ? 5 : 0);
        const scoreB = (b.isSvg ? 10 : 0) + (b.isApple ? 5 : 0);
        return scoreB - scoreA;
    });
    return links.map(l => l.href);
}

class IconService {
    constructor(options = {}) {
        this.cache = new Map();
        this.inFlight = new Map();
        this.maxEntries = options.maxEntries || DEFAULT_CACHE_MAX;
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this.fetchImpl = options.fetch || globalThis.fetch;
    }

    validateUrl(urlStr) {
        if (!urlStr || typeof urlStr !== 'string') return null;
        try {
            const parsed = new URL(urlStr);
            if (!['http:', 'https:'].includes(parsed.protocol)) return null;
            if (isBlockedHost(parsed.hostname)) return null;
            return parsed;
        } catch {
            return null;
        }
    }

    async getIcon(urlStr) {
        const parsed = this.validateUrl(urlStr);
        if (!parsed) return null;

        const cacheKey = parsed.origin;
        const now = Date.now();

        // 检查缓存
        const cached = this.cache.get(cacheKey);
        if (cached) {
            if (cached.data && (now - cached.timestamp < this.ttlMs)) {
                return cached;
            }
            if (!cached.data && (now - cached.timestamp < NEGATIVE_TTL_MS)) {
                return null;
            }
        }

        // 单飞行合并相同 origin 的并发请求
        if (this.inFlight.has(cacheKey)) {
            return this.inFlight.get(cacheKey);
        }

        const task = this._fetchAndCache(parsed, cacheKey);
        this.inFlight.set(cacheKey, task);
        try {
            return await task;
        } finally {
            this.inFlight.delete(cacheKey);
        }
    }

    async _fetchAndCache(parsed, cacheKey) {
        try {
            const result = await this._resolveSiteIcon(parsed);
            if (result && result.data && result.data.length > 0) {
                this._setCache(cacheKey, {
                    data: result.data,
                    contentType: result.contentType,
                    timestamp: Date.now()
                });
                return result;
            }
        } catch {}

        // 记录短期负缓存，避免反复向故障网站施加抓取压力
        this._setCache(cacheKey, {
            data: null,
            contentType: null,
            timestamp: Date.now()
        });
        return null;
    }

    _setCache(key, entry) {
        if (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) this.cache.delete(oldestKey);
        }
        this.cache.set(key, entry);
    }

    async _resolveSiteIcon(targetUrl) {
        const candidateUrls = [];
        const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        // 阶段 1：尝试拉取页面 HTML 前 64 KiB 查找 <link rel="icon">
        try {
            const pageRes = await this.fetchImpl(targetUrl.href, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                signal: AbortSignal.timeout(3500),
                redirect: 'follow'
            });

            if (pageRes.ok) {
                const finalUrl = pageRes.url || targetUrl.href;
                let html = '';
                if (pageRes.body && typeof pageRes.body.getReader === 'function') {
                    const reader = pageRes.body.getReader();
                    let bytesRead = 0;
                    while (bytesRead < HTML_READ_LIMIT) {
                        const { done, value } = await reader.read();
                        if (done || !value) break;
                        html += new TextDecoder().decode(value, { stream: true });
                        bytesRead += value.length;
                        if (html.includes('</head>')) break;
                    }
                    reader.cancel().catch(() => {});
                } else if (typeof pageRes.text === 'function') {
                    const text = await pageRes.text();
                    html = text.slice(0, HTML_READ_LIMIT);
                }

                const hrefs = extractIconLinks(html);
                for (const href of hrefs) {
                    try {
                        candidateUrls.push(new URL(href, finalUrl).href);
                    } catch {}
                }
            }
        } catch {}

        // 阶段 2：始终加入 ${origin}/favicon.ico 作为候选
        try {
            candidateUrls.push(new URL('/favicon.ico', targetUrl.origin).href);
        } catch {}

        const deduplicated = [...new Set(candidateUrls)];

        // 阶段 3：依次尝试候选图标地址
        for (const iconUrl of deduplicated) {
            try {
                const iconRes = await this.fetchImpl(iconUrl, {
                    headers: {
                        'User-Agent': userAgent,
                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                    },
                    signal: AbortSignal.timeout(3000),
                    redirect: 'follow'
                });

                if (!iconRes.ok) continue;

                let buffer;
                if (typeof iconRes.arrayBuffer === 'function') {
                    const ab = await iconRes.arrayBuffer();
                    buffer = Buffer.from(ab);
                } else if (typeof iconRes.buffer === 'function') {
                    buffer = await iconRes.buffer();
                }

                if (!buffer || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;

                const declaredType = (iconRes.headers.get('content-type') || '').toLowerCase();
                const contentType = detectContentType(buffer, declaredType, iconUrl);
                return { data: buffer, contentType };
            } catch {}
        }

        return null;
    }
}

const defaultIconService = new IconService();

module.exports = {
    IconService,
    defaultIconService,
    extractIconLinks,
    detectContentType
};
