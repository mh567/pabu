'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IconService, extractIconLinks, detectContentType } = require('../lib/icon-service');

test('icon service: URL 校验过滤非法协议与敏感元数据主机', () => {
    const service = new IconService();
    assert.equal(service.validateUrl('not-a-url'), null);
    assert.equal(service.validateUrl('ftp://example.com'), null);
    assert.equal(service.validateUrl('javascript:alert(1)'), null);
    assert.equal(service.validateUrl('http://169.254.169.254/latest/meta-data/'), null);
    assert.equal(service.validateUrl('http://metadata.google.internal/computeMetadata/v1/'), null);
    assert.equal(service.validateUrl('http://sub.metadata.google.internal/'), null);

    const valid = service.validateUrl('https://example.com/some/path?query=1');
    assert.equal(valid.origin, 'https://example.com');
    assert.equal(valid.protocol, 'https:');
});

test('icon service: extractIconLinks 提取并优先排序 SVG 与 Apple Touch 图标', () => {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <link rel="stylesheet" href="/style.css">
            <link rel="shortcut icon" href="/favicon.ico">
            <link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
            <link rel="icon" type="image/svg+xml" href="/logo.svg">
            <link rel="apple-touch-icon" href="/apple-touch-icon.png">
        </head>
        </html>
    `;
    const links = extractIconLinks(html);
    assert.equal(links.length, 4);
    assert.equal(links[0], '/logo.svg', 'SVG 排在最前');
    assert.equal(links[1], '/apple-touch-icon.png', 'Apple Touch Icon 排在第二');
    assert.ok(links.includes('/favicon.ico'));
    assert.ok(links.includes('/icon-32.png'));
});

test('icon service: detectContentType 精准识别魔数与 SVG', () => {
    // PNG magic
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.equal(detectContentType(png, 'text/plain', 'test.ico'), 'image/png');

    // ICO magic
    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
    assert.equal(detectContentType(ico, '', ''), 'image/x-icon');

    // SVG
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>');
    assert.equal(detectContentType(svg, 'text/plain', 'logo.svg'), 'image/svg+xml');
});

test('icon service: 模拟拉取 HTML 解析图标并缓存', async () => {
    let fetchCount = 0;
    const fakeFetch = async (url) => {
        fetchCount++;
        if (url === 'https://site.test/') {
            return {
                ok: true,
                url: 'https://site.test/',
                text: async () => '<html><head><link rel="icon" href="/brand.png"></head></html>'
            };
        }
        if (url === 'https://site.test/brand.png') {
            const pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            return {
                ok: true,
                headers: new Map([['content-type', 'image/png']]),
                arrayBuffer: async () => pngBytes.buffer
            };
        }
        return { ok: false, status: 404 };
    };

    const service = new IconService({ fetch: fakeFetch });
    const first = await service.getIcon('https://site.test/');
    assert.ok(first);
    assert.equal(first.contentType, 'image/png');
    assert.equal(fetchCount, 2, '抓取 HTML 和图标共 2 次');

    // 第二次调用命中缓存，fetch 计数不增加
    const second = await service.getIcon('https://site.test/another-page');
    assert.ok(second);
    assert.equal(second.contentType, 'image/png');
    assert.equal(fetchCount, 2, '命中缓存，未发起新网络请求');
});

test('icon service: HTML 无图标时回退到 favicon.ico', async () => {
    let icoFetched = false;
    const fakeFetch = async (url) => {
        if (url === 'https://fallback.test/') {
            return {
                ok: true,
                url: 'https://fallback.test/',
                text: async () => '<html><head><title>No icon tag</title></head></html>'
            };
        }
        if (url === 'https://fallback.test/favicon.ico') {
            icoFetched = true;
            const icoBytes = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
            return {
                ok: true,
                headers: new Map([['content-type', 'image/x-icon']]),
                arrayBuffer: async () => icoBytes.buffer
            };
        }
        return { ok: false, status: 404 };
    };

    const service = new IconService({ fetch: fakeFetch });
    const result = await service.getIcon('https://fallback.test/');
    assert.ok(result);
    assert.equal(icoFetched, true, '成功回退到 favicon.ico');
    assert.equal(result.contentType, 'image/x-icon');
});

test('icon service: 并发相同 origin 请求合并为单飞行', async () => {
    let siteFetches = 0;
    const fakeFetch = async (url) => {
        if (url.startsWith('https://singleflight.test/page')) {
            siteFetches++;
            await new Promise(r => setTimeout(r, 20));
            return {
                ok: true,
                url: 'https://singleflight.test/',
                text: async () => '<html><head><link rel="icon" href="/icon.svg"></head></html>'
            };
        }
        if (url === 'https://singleflight.test/icon.svg') {
            const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
            return {
                ok: true,
                headers: new Map([['content-type', 'image/svg+xml']]),
                arrayBuffer: async () => svgBytes
            };
        }
        return { ok: false, status: 404 };
    };

    const service = new IconService({ fetch: fakeFetch });
    const [res1, res2, res3] = await Promise.all([
        service.getIcon('https://singleflight.test/page1'),
        service.getIcon('https://singleflight.test/page2'),
        service.getIcon('https://singleflight.test/page3')
    ]);
    assert.ok(res1);
    assert.ok(res2);
    assert.ok(res3);
    assert.equal(siteFetches, 1, '并发三请求只发起一次目标站抓取');
});

test('icon service: 抓取失败记录负缓存并在超大文件时拒绝', async () => {
    let attempts = 0;
    const fakeFetch = async () => {
        attempts++;
        return { ok: false, status: 500 };
    };

    const service = new IconService({ fetch: fakeFetch });
    const fail1 = await service.getIcon('https://broken.test/');
    assert.equal(fail1, null);
    assert.equal(attempts, 2, '尝试 HTML 和 favicon.ico');

    // 短期内再次访问命中负缓存，不再重试
    const fail2 = await service.getIcon('https://broken.test/');
    assert.equal(fail2, null);
    assert.equal(attempts, 2, '命中负缓存，未重试');
});
