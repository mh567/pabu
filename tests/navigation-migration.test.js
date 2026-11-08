'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase, MIGRATIONS } = require('../lib/db');

const config = name => ({
    theme: 'auto',
    showBookmarkIcons: true,
    searchEngine: 'g',
    searchEngines: [{ id: 'g', name: 'Google', url: 'https://www.google.com/search?q=' }],
    categories: [{ id: 'c1', name: name, bookmarks: [{ id: 'b1', title: 'Example', url: 'https://example.com/' }] }]
});

function databaseAtPreviousVersion(file) {
    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    for (let version = 0; version < MIGRATIONS.length - 1; version++) {
        db.transaction(() => {
            MIGRATIONS[version](db);
            db.pragma(`user_version = ${version + 1}`);
        })();
    }
    return db;
}

test('navigation migration: published becomes the single site document and old receipts are cleared', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pabu-nav-migration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'pabu.db');

    const db = databaseAtPreviousVersion(file);
    const insert = db.prepare('INSERT INTO navigation_documents (id, config_json, revision) VALUES (?, ?, ?)');
    insert.run('admin', JSON.stringify({ ...config('Admin'), privacyMode: true, legacyPrivate: 'private' }), 9);
    insert.run('draft', JSON.stringify(config('Draft')), 4);
    insert.run('published', JSON.stringify(config('Published')), 6);
    db.prepare('INSERT INTO navigation_receipts (domain, operation_id, digest, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('admin', 'old-operation', 'digest', '{}', Date.now());
    db.close();

    const migrated = openDatabase(file);
    try {
        assert.equal(migrated.pragma('user_version', { simple: true }), MIGRATIONS.length);
        const rows = migrated.prepare('SELECT id, config_json, revision FROM navigation_documents').all();
        assert.deepEqual(rows.map(row => row.id), ['site']);
        assert.equal(rows[0].revision, 6, '沿用 published 的版本号');
        assert.deepEqual(JSON.parse(rows[0].config_json), config('Published'));
        assert.equal(migrated.prepare('SELECT COUNT(*) n FROM navigation_receipts').get().n, 0);
    } finally {
        migrated.close();
    }

    const reopened = openDatabase(file);
    try {
        assert.deepEqual(reopened.prepare('SELECT id FROM navigation_documents').all().map(row => row.id), ['site']);
        assert.equal(reopened.pragma('user_version', { simple: true }), MIGRATIONS.length);
    } finally {
        reopened.close();
    }
});

test('navigation migration: admin fallback is stripped to the public schema', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pabu-nav-migration-admin-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'pabu.db');

    const db = databaseAtPreviousVersion(file);
    const admin = { ...config('Legacy admin'), privacyMode: true, legacyPrivate: 'must-not-leak' };
    db.prepare('INSERT INTO navigation_documents (id, config_json, revision) VALUES (?, ?, ?)')
        .run('admin', JSON.stringify(admin), 3);
    db.close();

    const migrated = openDatabase(file);
    try {
        const row = migrated.prepare("SELECT config_json, revision FROM navigation_documents WHERE id = 'site'").get();
        const stored = JSON.parse(row.config_json);
        assert.equal(row.revision, 3);
        assert.equal(stored.privacyMode, undefined);
        assert.equal(stored.legacyPrivate, undefined);
        assert.deepEqual(stored, config('Legacy admin'));
    } finally {
        migrated.close();
    }
});
