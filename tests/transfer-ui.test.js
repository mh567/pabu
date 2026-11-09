'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const filePage = fs.readFileSync(path.join(__dirname, '..', 'public/file.html'), 'utf8');

test('上传在途有持续的关闭提示与浏览器拦截', () => {
    assert.match(app, /上传期间请不要关闭或刷新此页面/, '进度层持续提示不要关闭');
    assert.match(app, /this\.transferActive = true/, '上传开始后打开关闭守卫');
    assert.match(app, /if \(this\.transferActive \|\|/, 'beforeunload 会检查上传状态');
    assert.match(app, /finally\s*\{\s*this\.transferActive = false;/, '上传结束后释放守卫');
});

test('下载在途有持续的关闭提示与浏览器拦截', () => {
    assert.match(filePage, /下载期间请不要关闭或刷新此页面/, '取件页静态提示不要关闭');
    assert.match(filePage, /let downloading = false/, '存在下载状态');
    assert.match(filePage, /if \(!downloading\) return/, 'beforeunload 按下载状态放行');
    assert.match(filePage, /请不要关闭页面/, '下载与解密过程中持续提示');
});

test('分享成功后复用结果面板显示取件码、二维码与链接', () => {
    const result = app.slice(app.indexOf('showPasteResult(code'), app.indexOf('pasteExpiryText(expiresAt)'));
    assert.match(result, /paste-code/, '显示取件码');
    assert.match(result, /paste-qr/, '显示二维码');
    assert.match(result, /paste-link/, '提供复制链接按钮');
    assert.match(result, /paste-url/, '展示完整链接');
    assert.match(result, /paste-expiry/, '展示有效期');
    assert.match(result, /meta\.kind === 'file'/, '文件分享附带文件名与大小');
});
