'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');

test('Pabu home exposes the search-based temporary text sharing flow', () => {
    assert.match(html, /id="searchInput"/);
    assert.match(app, /createPaste\(content/);
    assert.match(app, /fetch\('\/api\/p'/);
    assert.match(app, /Pabu/);
});

test('the browser generates the short code and encrypts before sending it to the sharing API', () => {
    const encrypt = app.slice(app.indexOf('async encryptWithShortCode(text, shortCode'), app.indexOf('async showPasteOptions'));
    assert.match(encrypt, /crypto\.subtle\.encrypt/);
    assert.match(encrypt, /deriveShortKey\(shortCode, salt, pin\)/);
    assert.match(app, /ShareCode\.generateShortCode\(\)/);
    assert.match(app, /await ShareCode\.deriveId\(code\)/);
    assert.match(app, /await ShareCode\.deriveProof\(code\)/);
    assert.equal(app.includes("fetch('/api/p/code'"), false);
});
