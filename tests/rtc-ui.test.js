'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const rtc = fs.readFileSync(path.join(root, 'public/rtc-transfer.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const filePage = fs.readFileSync(path.join(root, 'public/file.html'), 'utf8');

test('首页先加载实时传输模块，再启动应用', () => {
    assert.match(index, /<script src="rtc-transfer\.js"><\/script>\s*<script src="app\.js"><\/script>/);
});

test('超级搜索框把 5 位数字识别为实时取件码', () => {
    assert.match(app, /ShareCode\.isRtcCode\(raw\)/);
    assert.match(app, /kind: 'rtc'/);
    assert.match(app, /RtcTransfer\.receive\(pickup\.code\)/);
    assert.match(rtc, /ShareCode\.isRtcCode\(code\)/);
});

test('文件分享默认走实时直连，并保留服务器中转回退', () => {
    assert.match(app, /rtc\.share\(file/);
    assert.match(app, /shareFileRelay\(pendingFile, notifyRelay\)/);
    assert.match(app, /notifyRelay\(code\)/);
    assert.match(app, /notifyRelay\(null\)/);
});

test('中转回退的文件密钥派生仍在，且与取件页参数一致', () => {
    assert.match(app, /async deriveKey\(code\)/);
    assert.match(app, /code \+ '-pabu-e2e'/);
    assert.match(app, /'pabu-paste-v2'/);
    assert.match(app, /iterations: 100000/);
    assert.match(filePage, /code \+ '-pabu-e2e'/);
    assert.match(filePage, /'pabu-paste-v2'/);
    assert.match(filePage, /iterations: 100000/);
});

test('背压等待在监听器挂上后立即复查并轮询', () => {
    assert.match(rtc, /channel\.bufferedAmount <= BUFFER_LOW/);
    assert.match(rtc, /setInterval\(check, 50\)/);
});

test('数据通道 meta 消息用 mime 字段承载 MIME，避免覆盖消息类型', () => {
    assert.match(rtc, /mime: this\.file\.type/);
    assert.match(rtc, /message\.mime/);
});

test('实时传输模块使用 WebRTC、16 KiB 分片和背压', () => {
    assert.match(rtc, /new RTCPeerConnection\(/);
    assert.match(rtc, /createDataChannel\('pabu-file'/);
    assert.match(rtc, /CHUNK_SIZE = 16 \* 1024/);
    assert.match(rtc, /bufferedAmountLowThreshold = BUFFER_LOW/);
    assert.match(rtc, /bufferedAmount < BUFFER_HIGH/);
});

test('实时传输期间拦截关闭并给出持续提示', () => {
    assert.match(rtc, /window\.addEventListener\('beforeunload'/);
    assert.match(rtc, /if \(!this\.transferring\) return/);
    assert.match(rtc, /传输期间请不要关闭或刷新页面/);
    assert.match(rtc, /window\.app\.transferActive = !!active/);
});

test('直连建立后显示确认码，中转回退会送达取件码', () => {
    assert.match(rtc, /async function deriveSas\(pc\)/);
    assert.match(rtc, /a=fingerprint:sha-256/);
    assert.match(rtc, /relay-pending/);
    assert.match(rtc, /sendControl\('relay', \{ code \}\)/);
    assert.match(rtc, /location\.assign\('\/f\/' \+ encodeURIComponent\(message\.code\)\)/);
});

test('Service Worker 缓存实时传输模块', () => {
    assert.match(sw, /const CACHE = 'pabu-v24'/);
    assert.match(sw, /'\/rtc-transfer\.js'/);
});
