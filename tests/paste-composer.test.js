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

test('the browser encrypts text before sending it to the sharing API', () => {
    const encrypt = app.slice(app.indexOf('async encrypt(text, code)'), app.indexOf('async decrypt(encryptedBase64, code)'));
    const keyDerivation = app.slice(app.indexOf('async deriveKey(code)'), app.indexOf('async encrypt(text, code)'));
    assert.match(encrypt, /crypto\.subtle\.encrypt/);
    assert.match(encrypt, /deriveKey\(code\)/);
    assert.match(keyDerivation, /PBKDF2/);
    assert.match(keyDerivation, /AES-GCM/);
});
