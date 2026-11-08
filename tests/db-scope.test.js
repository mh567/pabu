'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../lib/db');

test('fresh Pabu database contains navigation, sessions and sync tables only', () => {
    const db = openDatabase(':memory:');
    try {
        const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name).sort();
        assert.deepEqual(names, [
            'navigation_documents', 'navigation_receipts', 'sessions',
            'sync_devices', 'sync_invites', 'sync_receipts', 'sync_settings', 'sync_spaces'
        ]);
    } finally {
        db.close();
    }
});
