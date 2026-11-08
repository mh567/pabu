'use strict';
const { createHash } = require('node:crypto');
const { validate, publicConfig } = require('../public/navigation-schema');

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, max = 200) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }

const SITE = 'site';

function createNavigation(db, original, defaults) {
    if (!db.prepare('SELECT 1 FROM navigation_documents LIMIT 1').get()) {
        const site = validate(publicConfig({
            ...defaults,
            ...original,
            categories: original.categories ?? original.bookmarks ?? defaults.categories
        }));
        db.prepare('INSERT INTO navigation_documents (id, config_json, revision) VALUES (?, ?, 1)')
            .run(SITE, JSON.stringify(site));
    }

    function read(id = SITE) {
        if (id !== SITE) fail('未知导航域', 500);
        const row = db.prepare('SELECT * FROM navigation_documents WHERE id = ?').get(SITE);
        if (!row) fail('站点导航不存在', 500);
        return { config: JSON.parse(row.config_json), revision: row.revision };
    }

    function write(id, body) {
        if (id !== SITE) fail('未知导航域', 500);
        if (!Number.isSafeInteger(body.revision) || !text(body.operationId, 100)) {
            fail('页面版本不兼容，请刷新后重试', 409);
        }
        const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        return db.transaction(() => {
            db.prepare('DELETE FROM navigation_receipts WHERE created_at < ?').run(Date.now() - 86400000);

            const receipt = db.prepare('SELECT * FROM navigation_receipts WHERE domain = ? AND operation_id = ?')
                .get(SITE, body.operationId);
            if (receipt) {
                if (receipt.digest !== digest) fail('同一操作标识不能提交不同内容', 409);
                return JSON.parse(receipt.response_json);
            }

            const current = read();
            if (current.revision !== body.revision) fail('站点导航已改变，请刷新后处理冲突', 409);
            if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) fail('配置必须是对象');

            const config = publicConfig(validate(body.config));
            const revision = current.revision + 1;
            db.prepare('UPDATE navigation_documents SET config_json = ?, revision = ? WHERE id = ?')
                .run(JSON.stringify(config), revision, SITE);

            const result = { success: true, revision };
            db.prepare('INSERT INTO navigation_receipts VALUES (?, ?, ?, ?, ?)')
                .run(SITE, body.operationId, digest, JSON.stringify(result), Date.now());
            return result;
        })();
    }

    return { read, write };
}

module.exports = { createNavigation };
