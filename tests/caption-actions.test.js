'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');

test('搜索框下方的三段说明都渲染成可点击按钮', () => {
    const start = html.indexOf('<div class="search-caption"');
    assert.ok(start > -1, '存在说明行容器');
    const caption = html.slice(start, html.indexOf('</div>', start));

    const ids = [...caption.matchAll(/<button[^>]*id="(caption[A-Za-z]+)"/g)].map(match => match[1]);
    assert.deepEqual(ids, ['captionShareText', 'captionShareFile', 'captionPickup']);

    for (const text of ['输入&gt;', '分享文本', '输入》', '分享文件', '输入取件码', '取回文本文件']) {
        assert.ok(caption.includes(text), `说明行包含「${text}」`);
    }
    assert.equal(/aria-hidden="true"/.test(caption), false, '可点击入口不再对读屏隐藏');
});

test('三个说明按钮都绑定了点击行为', () => {
    for (const id of ['captionShareText', 'captionShareFile', 'captionPickup']) {
        assert.ok(app.includes(`$('#${id}').onclick`), `${id} 必须绑定 onclick`);
    }
    assert.ok(app.includes("'> ' + text"), '分享文本按钮会进入分享输入态');
    assert.ok(app.includes("input.value = '》'"), '分享文件按钮会进入文件选择态');
    assert.ok(app.includes("$('#transferFileInput').click()"), '分享文件按钮复用文件选择框');
});

test('半角 > 与全角 》 分别触发文本分享和文件选择', () => {
    assert.match(app, /isTextShareTrigger\(char\)\s*\{\s*return char === '>'/, '半角 > 只负责文本分享');
    assert.match(app, /isFileShareTrigger\(char\)\s*\{\s*return char === '》'/, '全角 》 只负责文件选择');
    assert.match(app, /isFileShareTrigger\(value\[0\]\)[\s\S]{0,120}transferFileInput'\)\.click\(\)/, '文件触发符回车后打开文件选择框');
    assert.match(app, /isTextShareTrigger\(value\[0\]\)[\s\S]{0,160}showPasteOptions/, '文本触发符回车后打开分享保护');
});

test('管理后台的站点预览同步显示三段说明', () => {
    const preview = app.slice(app.indexOf('class="search-caption" aria-hidden="true"'));
    const line = preview.slice(0, preview.indexOf('</div>'));
    assert.equal((line.match(/caption-action/g) || []).length, 3, '预览里也保留三个胶囊形状');
});
