'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installation } = require('./helpers/installation');
const ROOT = path.resolve(__dirname, '..');
const json = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

test('release: package, lockfile, runtime version and latest changelog agree', () => {
    const version = json('package.json').version;
    assert.equal(json('package-lock.json').version, version);
    assert.equal(json('package-lock.json').packages[''].version, version);
    assert.equal(json('version.json').version, version);
    assert.equal(json('CHANGELOG.json').versions[0].version, version);
});

test('release: a second update recognizes the installed version and does not stop the service again', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pabu-update-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = path.join(dir, 'installed');
    const source = path.join(dir, 'source');
    fs.mkdirSync(app); fs.mkdirSync(source);
    fs.writeFileSync(path.join(app, 'version.json'), JSON.stringify({ version: '0.8.7' }));
    fs.writeFileSync(path.join(app, 'pabu.sh'), '#!/bin/bash\n');
    fs.writeFileSync(path.join(app, 'config.json'), '{"preserved":true}');
    for (const file of ['version.json', 'CHANGELOG.json', 'package.json']) fs.copyFileSync(path.join(ROOT, file), path.join(source, file));
    const script = fs.readFileSync(path.join(ROOT, 'pabu.sh'), 'utf8');
    const update = script.slice(script.indexOf('do_update() {'), script.indexOf('\ndo_uninstall() {'));
    const result = spawnSync('bash', ['-c', `set -e
APP_DIR="$TEST_APP_DIR"
APP_NAME=pabu
ensure_local_install() { :; }
print_banner() { :; }
check_node_version() { :; }
log_info() { printf '%s\\n' "$1"; }
log_step() { :; }
log_error() { printf '%s\\n' "$1"; }
get_latest_source() { LATEST_VERSION="$TEST_VERSION"; SOURCE_URL=fixture; }
do_stop() { echo STOP_SERVICE; }
do_start() { echo START_SERVICE; }
install_dependencies() { :; }
ensure_manager_script() { :; }
extract_source() { mkdir -p "$2"; cp -R "$TEST_SOURCE"/. "$2"/; }
${update}
do_update
(do_update)
`], { encoding: 'utf8', env: { ...process.env, TEST_APP_DIR: app, TEST_SOURCE: source, TEST_VERSION: json('package.json').version } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/STOP_SERVICE/g) || []).length, 1, result.stdout);
    assert.match(result.stdout, /已是最新版本，无需更新/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'config.json'))).preserved, true);
});

test('HTTP: displayed version and changelog match the release package', async t => {
    const app = await installation(t);
    await app.start();
    const version = await (await app.request('/api/version')).json();
    const changelog = await (await app.request('/api/changelog')).json();
    assert.equal(version.version, json('package.json').version);
    assert.equal(changelog.versions[0].version, version.version);
});
