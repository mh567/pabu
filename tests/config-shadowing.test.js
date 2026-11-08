'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('../server-config/defaults');

test('Pabu runtime identity and storage defaults are independent', () => {
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server-config.example.json'), 'utf8'));
    assert.equal(defaults.server.port, 4001);
    assert.equal(defaults.security.sessionCookieName, 'pabu_session');
    assert.equal(defaults.paths.database, 'pabu.db');
    assert.equal(example.server.port, defaults.server.port);
    assert.equal(example.paths.database, defaults.paths.database);
    assert.equal('webdav' in defaults, false);
    assert.equal('selfSignedCert' in defaults.security, false);
});
