// Checks of what a stranger, or a damaged file, must not be able to do to the server. Each one runs a real server on a
// spare port with a data folder of its own (never ./data).   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = mkdtempSync(join(tmpdir(), 'grape-server-test-'));
const port = 20000 + Math.floor(Math.random() * 20000);
// the program and the installer the server would give out: stand-ins with known bytes
const files = mkdtempSync(join(tmpdir(), 'grape-server-files-'));
const SETUP = Buffer.concat([Buffer.from('MZ-setup-stub-'), crypto.randomBytes(4000)]);
const APP = Buffer.concat([Buffer.from('MZ-grape-app-'), crypto.randomBytes(300000)]);
writeFileSync(join(files, 'grape-setup.exe'), SETUP);
writeFileSync(join(files, 'Grape.exe'), APP);
writeFileSync(join(files, 'version.json'), JSON.stringify({ version: '9.9.9' }));
const env = {
  ...process.env, GRAPE_DATA: data, GRAPE_PORT: String(port), GRAPE_NO_PAGES: '1', GRAPE_DEV: '0',
  GRAPE_SETUP_STUB: join(files, 'grape-setup.exe'), GRAPE_APP_EXE: join(files, 'Grape.exe'), GRAPE_APP_VERSION_FILE: join(files, 'version.json'),
};
let server;

const cli = (...args) => spawnSync(process.execPath, [join(root, 'server.js'), ...args], { env, encoding: 'utf8' });
const health = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/v1/health', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(0));
  req.on('timeout', () => { req.destroy(); resolve(0); });
});

before(async () => {
  writeFileSync(join(data, 'discord.json'), JSON.stringify({ client_id: '123456789', client_secret: 's3cret', redirect_uri: `http://127.0.0.1:${port}/v1/discord/callback` }));
  server = spawn(process.execPath, [join(root, 'server.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 100 && (await health()) !== 200; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await health(), 200, 'the server started');
});
after(() => { server.kill(); rmSync(data, { recursive: true, force: true }); rmSync(files, { recursive: true, force: true }); });

const upgradeRequest = (extra = '') => `GET /v1/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

test('a connection that is turned away and then reset does not end the server', async () => {
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(upgradeRequest('Origin: http://evil.example\r\n')));   // a page's request: refused
      s.on('data', () => s.resetAndDestroy());
      s.on('error', () => {});
      s.on('close', resolve);
    });
  }
  assert.equal(await health(), 200, 'still answering');
  assert.equal(server.exitCode, null, 'still running');
});

test('before it has logged in, a connection may send only a little', async () => {
  const code = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(upgradeRequest()));
    let upgraded = false;
    let buf = Buffer.alloc(0);
    s.on('error', () => {});
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded && buf.includes('\r\n\r\n')) {
        upgraded = true;
        buf = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
        // a text frame that is not finished, 20 KB long (masked with zeros, as a client must mask)
        const header = Buffer.from([0x01, 0x80 | 126, 20000 >> 8, 20000 & 255, 0, 0, 0, 0]);
        s.write(Buffer.concat([header, Buffer.alloc(20000, 0x61)]));
      }
      if (upgraded && buf.length >= 4 && buf[0] === 0x88) resolve(buf.readUInt16BE(2));    // a close frame: its code
    });
    s.on('close', () => resolve(0));
    setTimeout(() => resolve(-1), 4000);
  });
  assert.equal(code, 1009, 'closed with "too big"');
});

test('a data file that cannot be read is never taken for an empty one', () => {
  const made = cli('genkey', 'week', '3', 'test');
  assert.equal(made.status, 0, made.stderr);
  const before = readFileSync(join(data, 'keys.json'), 'utf8');
  assert.equal(JSON.parse(before) && Object.keys(JSON.parse(before)).length, 3);
  writeFileSync(join(data, 'keys.json'), before.slice(0, 40));                    // damaged: a crash, a bad edit
  const again = cli('genkey', 'week', '1', 'test');
  assert.notEqual(again.status, 0, 'refuses to change a file it cannot read');
  assert.match(again.stderr, /could not be read/);
  assert.equal(readFileSync(join(data, 'keys.json'), 'utf8'), before.slice(0, 40), 'and leaves it as it was');
  writeFileSync(join(data, 'keys.json'), before);
});

test('names that belong to every object are not plans, users or computers', () => {
  assert.notEqual(cli('genkey', 'constructor').status, 0, 'a plan called constructor');
  assert.notEqual(cli('genkey', '__proto__').status, 0);
  const hit = cli('revoke', '__proto__');
  assert.notEqual(hit.status, 0, 'a user called __proto__');
});

test('only wrong passwords are counted, and only against the address they came from', () => {
  assert.equal(cli('admin-password', 'a-long-admin-password').status, 0);
  const run = spawnSync(process.execPath, ['-e', `
    const core = require(${JSON.stringify(join(root, 'lib', 'core.js'))});
    (async () => {
      const out = {};
      for (let i = 0; i < 12; i++) await core.adminApi('login', { password: 'wrong' }, { ip: '1.1.1.1', cookie: '' });
      out.sameAddressBlocked = (await core.adminApi('login', { password: 'a-long-admin-password' }, { ip: '1.1.1.1', cookie: '' })).status;
      out.otherAddressRight = (await core.adminApi('login', { password: 'a-long-admin-password' }, { ip: '2.2.2.2', cookie: '' })).status;
      for (let i = 0; i < 5; i++) await core.adminApi('login', { password: 'a-long-admin-password' }, { ip: '3.3.3.3', cookie: '' });
      out.rightOnesNeverCounted = (await core.adminApi('login', { password: 'a-long-admin-password' }, { ip: '3.3.3.3', cookie: '' })).status;
      console.log(JSON.stringify(out));
    })();`], { env, encoding: 'utf8' });
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.sameAddressBlocked, 429, 'ten wrong ones from one address block that address');
  assert.equal(out.otherAddressRight, 200, 'and nobody else');
  assert.equal(out.rightOnesNeverCounted, 200, 'a right password is never held up');
});

test('a login link made on a computer shows its code before going to Discord, and only this site can continue it', async () => {
  // a computer's login needs a logged-in session to be started; the pieces that need none are the two pages
  const get = (path) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || '' }); }));
  assert.match((await get('/login/discord?state=00ff')).location, /why=expired/, 'a state that is not a login');
  const web = await get('/login/discord?back=/');                                     // the website's own login: straight to Discord
  assert.match(web.location, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
  assert.ok(!web.location.includes('s3cret'), 'the application secret is never in a link');
});

// ---- the installer: it works once

const fetchBytes = (method, path, body) => new Promise((resolve, reject) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = http.request({ host: '127.0.0.1', port, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, json: () => JSON.parse(bytes.toString('utf8')) }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

test('an installer works once, on one computer, and tells nothing to a second', async () => {
  const made = cli('installer', '24', 'test one');
  assert.equal(made.status, 0, made.stderr);
  const url = made.stdout.match(/http:\/\/\S+\/get\/(\S+)/);
  assert.ok(url, 'the link is printed');
  const token = url[1];
  assert.ok(!readFileSync(join(data, 'installers.json'), 'utf8').includes(token), 'the token itself is never kept');

  // the download: the setup program, with a trailer holding the server's address and this token
  const file = await fetchBytes('GET', '/get/' + token);
  assert.equal(file.status, 200);
  assert.ok(file.bytes.subarray(0, SETUP.length).equals(SETUP), 'the stub is unchanged');
  assert.equal(file.bytes.subarray(-8).toString(), 'GRPSETUP');
  const size = file.bytes.readUInt32LE(file.bytes.length - 12);
  const trailer = JSON.parse(file.bytes.subarray(file.bytes.length - 12 - size, file.bytes.length - 12).toString());
  assert.equal(trailer.token, token);
  assert.match(trailer.server, /^http:\/\/127\.0\.0\.1:\d+$/);

  const pcA = 'a'.repeat(64), pcB = 'b'.repeat(64);
  assert.equal((await fetchBytes('POST', '/v1/install/claim', { token: 'x'.repeat(32), hwid: pcA })).status, 404, 'a token that was never made');
  const asked = await fetchBytes('POST', '/v1/install/check', { token, hwid: pcA });
  assert.equal(asked.status, 200, 'asking whether it is good');
  assert.equal(asked.json().size, APP.length);
  const claim = await fetchBytes('POST', '/v1/install/claim', { token, hwid: pcA });
  assert.equal(claim.status, 200, 'and asking does not use it up');
  const info = claim.json();
  assert.equal(info.size, APP.length);
  assert.equal(info.sha256, crypto.createHash('sha256').update(APP).digest('hex'));
  assert.equal(info.version, '9.9.9');
  assert.equal((await fetchBytes('POST', '/v1/install/claim', { token, hwid: pcB })).status, 403, 'another computer is turned away');
  assert.equal((await fetchBytes('GET', '/get/' + token)).status, 410, 'and the download is closed once it was started');

  assert.equal((await fetchBytes('POST', '/v1/install/done', { token, hwid: pcA })).status, 409, 'nothing was delivered yet');
  assert.equal((await fetchBytes('GET', '/v1/install/file/' + 'z'.repeat(32))).status, 403, 'a ticket that was never made');
  const program = await fetchBytes('GET', '/v1/install/file/' + info.ticket);
  assert.equal(program.status, 200);
  assert.ok(program.bytes.equals(APP), 'Grape arrives whole');
  assert.equal((await fetchBytes('GET', '/v1/install/file/' + info.ticket)).status, 403, 'a ticket opens once');
  await new Promise((r) => setTimeout(r, 200));

  assert.equal((await fetchBytes('POST', '/v1/install/done', { token, hwid: pcB })).status, 403, 'only the computer that took it can finish it');
  assert.equal((await fetchBytes('POST', '/v1/install/done', { token, hwid: pcA })).status, 200);
  const again = await fetchBytes('POST', '/v1/install/claim', { token, hwid: pcA });
  assert.equal(again.status, 410, 'used: not even the same computer');
  assert.match(again.json().error, /already used/);
  assert.equal((await fetchBytes('POST', '/v1/install/check', { token, hwid: pcA })).status, 410, 'a used installer says so before it starts');
  assert.match(cli('installers').stdout, /used/);
});

test('an installer that was interrupted can be started again by its own computer only, and one that was cancelled never', async () => {
  const token = cli('installer', '24').stdout.match(/\/get\/(\S+)/)[1];
  const pc = 'c'.repeat(64);
  const first = (await fetchBytes('POST', '/v1/install/claim', { token, hwid: pc })).json();
  assert.equal((await fetchBytes('GET', '/v1/install/file/' + first.ticket)).status, 200);        // the connection "dropped" before it said done
  const second = await fetchBytes('POST', '/v1/install/claim', { token, hwid: pc });
  assert.equal(second.status, 200, 'the same computer tries again');
  assert.equal((await fetchBytes('POST', '/v1/install/claim', { token, hwid: 'd'.repeat(64) })).status, 403);

  const other = cli('installer', '24', 'to cancel').stdout.match(/\/get\/(\S+)/)[1];
  const id = cli('installers').stdout.split('\n').find((l) => l.includes('to cancel')).split(/\s+/)[0];
  assert.equal(cli('revoke-installer', id).status, 0);
  assert.equal((await fetchBytes('GET', '/get/' + other)).status, 410);
  assert.equal((await fetchBytes('POST', '/v1/install/claim', { token: other, hwid: pc })).status, 410);
});

test('an installer that ran out of time cannot be started, a stranger gets nothing', async () => {
  const db = JSON.parse(readFileSync(join(data, 'installers.json'), 'utf8'));
  const token = cli('installer', '1', 'short').stdout.match(/\/get\/(\S+)/)[1];
  const now = JSON.parse(readFileSync(join(data, 'installers.json'), 'utf8'));
  const id = Object.keys(now).find((k) => !db[k]);
  now[id].expires = Date.now() - 1000;
  writeFileSync(join(data, 'installers.json'), JSON.stringify(now));
  assert.equal((await fetchBytes('GET', '/get/' + token)).status, 410);
  assert.equal((await fetchBytes('POST', '/v1/install/claim', { token, hwid: 'e'.repeat(64) })).status, 410);
  assert.equal((await fetchBytes('GET', '/get/short')).status, 404, 'not even shaped like a token');
});

// ---- who is let in

test('an old version of Grape, or an unknown build, is turned away when the admin asks', () => {
  const run = spawnSync(process.execPath, ['-e', `
    const core = require(${JSON.stringify(join(root, 'lib', 'core.js'))});
    const out = {};
    out.nothingAsked = core.refuseBuild({});
    core.ops.saveSecurity({ min_version: '0.2.0' }, '1.1.1.1');
    out.old = !!core.refuseBuild({ version: '0.1.9' });
    out.noVersion = !!core.refuseBuild({});
    out.rightOne = core.refuseBuild({ version: '0.2.0' });
    out.newer = core.refuseBuild({ version: '1.0.0' });
    out.tenIsMoreThanNine = core.refuseBuild({ version: '0.10.0' });
    try { core.ops.saveSecurity({ min_version: 'banana' }, '1.1.1.1'); out.badVersion = 'accepted'; } catch (e) { out.badVersion = 'refused'; }
    core.ops.saveSecurity({ min_version: '', require_build: true }, '1.1.1.1');
    out.unknownBuild = !!core.refuseBuild({ version: '9.9.9', build: 'f'.repeat(64) });
    out.officialBuild = core.refuseBuild({ version: '9.9.9', build: ${JSON.stringify(crypto.createHash('sha256').update(APP).digest('hex'))} });
    core.ops.saveSecurity({}, '1.1.1.1');
    out.cleared = core.refuseBuild({});
    console.log(JSON.stringify(out));`], { env, encoding: 'utf8' });
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.nothingAsked, null, 'nothing is asked by default');
  assert.equal(out.old, true);
  assert.equal(out.noVersion, true, 'a copy that does not say its version is older than any');
  assert.equal(out.rightOne, null);
  assert.equal(out.newer, null);
  assert.equal(out.tenIsMoreThanNine, null, '0.10.0 is newer than 0.2.0');
  assert.equal(out.badVersion, 'refused');
  assert.equal(out.unknownBuild, true);
  assert.equal(out.officialBuild, null, 'the build the server hands out is always known');
  assert.equal(out.cleared, null);
});

test('the admin page can be limited to some addresses, and cannot be used to lock oneself out', () => {
  const run = spawnSync(process.execPath, ['-e', `
    const core = require(${JSON.stringify(join(root, 'lib', 'core.js'))});
    (async () => {
      const out = {};
      try { core.ops.saveSecurity({ admin_ips: '10.0.0.5' }, '1.1.1.1'); out.lockout = 'accepted'; } catch (e) { out.lockout = 'refused'; }
      try { core.ops.saveSecurity({ admin_ips: 'not-an-ip' }, '1.1.1.1'); out.junk = 'accepted'; } catch (e) { out.junk = 'refused'; }
      core.ops.saveSecurity({ admin_ips: '10.0.0.5, 1.1.1.1' }, '1.1.1.1');
      out.inList = (await core.adminApi('state', {}, { ip: '1.1.1.1', cookie: '' })).status;
      out.mappedForm = (await core.adminApi('state', {}, { ip: '::ffff:10.0.0.5', cookie: '' })).status;
      out.stranger = (await core.adminApi('state', {}, { ip: '8.8.8.8', cookie: '' })).status;
      out.strangerLogin = (await core.adminApi('login', { password: 'whatever' }, { ip: '8.8.8.8', cookie: '' })).status;
      core.ops.saveSecurity({}, '1.1.1.1');
      out.open = (await core.adminApi('state', {}, { ip: '8.8.8.8', cookie: '' })).status;
      console.log(JSON.stringify(out));
    })();`], { env, encoding: 'utf8' });
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.deepEqual(out, { lockout: 'refused', junk: 'refused', inList: 200, mappedForm: 200, stranger: 404, strangerLogin: 404, open: 200 });
});

test('a backup opens only with its password and brings every file back', () => {
  const file = join(files, 'copy.grapebak');
  const password = 'a-long-backup-password';
  const mine = { ...env, GRAPE_BACKUP_PASSWORD: password };
  const made = spawnSync(process.execPath, [join(root, 'server.js'), 'backup', file], { env: mine, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  assert.ok(!readFileSync(file, 'latin1').includes('"plan"'), 'nothing readable inside');
  const elsewhere = mkdtempSync(join(tmpdir(), 'grape-restore-'));
  const wrong = spawnSync(process.execPath, [join(root, 'server.js'), 'restore', file], { env: { ...env, GRAPE_DATA: elsewhere, GRAPE_BACKUP_PASSWORD: 'not-the-password-at-all' }, encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Wrong password/);
  const ok = spawnSync(process.execPath, [join(root, 'server.js'), 'restore', file], { env: { ...env, GRAPE_DATA: elsewhere, GRAPE_BACKUP_PASSWORD: password }, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  for (const name of ['keys.json', 'installers.json', 'admin.json']) assert.equal(readFileSync(join(elsewhere, name), 'utf8'), readFileSync(join(data, name), 'utf8'), name + ' came back as it was');
  const again = spawnSync(process.execPath, [join(root, 'server.js'), 'restore', file], { env: { ...env, GRAPE_DATA: elsewhere, GRAPE_BACKUP_PASSWORD: password }, encoding: 'utf8' });
  assert.notEqual(again.status, 0, 'a folder that holds data is not replaced without --force');
  rmSync(elsewhere, { recursive: true, force: true });
});

// ---- the download popup's API, and the daily limit

test('the download popup: log in, have time on the account, then a few installers a day; the admin can reset or change the limit', () => {
  const user = '555666777888999000';
  writeFileSync(join(data, 'users.json'), JSON.stringify({ [user]: { username: 'popup', global_name: 'Popup', plan: null, expires: 0 } }));
  const run = spawnSync(process.execPath, ['-e', `
    const core = require(${JSON.stringify(join(root, 'lib', 'core.js'))});
    const cookie = core.signCookie('site', ${JSON.stringify(user)}, 1);
    const ask = (action, c = cookie) => core.siteInstaller(c, action, '9.9.9.9');
    const redeem = (code, c = cookie) => core.siteRedeem(c, code, '9.9.9.9');
    const out = {};
    out.state_anon = ask('state', '');
    out.make_anon = ask('make', '').status;
    out.redeem_anon = redeem('GRAPE-AAAAA-AAAAA-AAAAA-AAAAA', '').status;
    // no time on the account: no installer
    out.no_time = (() => { const r = ask('make'); return { status: r.status, needs_time: r.body.needs_time, active: r.body.user.active }; })();
    // a key redeemed on the website gives time
    const [week, month] = [core.ops.makeKeys('week', 1)[0], core.ops.makeKeys('month', 1)[0]];
    out.bad_key = redeem('GRAPE-AAAAA-AAAAA-AAAAA-AAAAA').status;
    out.junk_key = redeem('nonsense').status;
    const good = redeem(week);
    out.redeemed = { status: good.status, active: good.body.user.active, plan: good.body.user.plan_name };
    out.key_twice = redeem(week).status;
    out.state_user = ask('state');
    out.makes = [1, 2, 3].map(() => ask('make').status);
    const fourth = ask('make');
    out.fourth = { status: fourth.status, limit: fourth.body.limit, mentions: /most for one day/.test(fourth.body.error), left: fourth.body.quota.left };
    core.ops.resetInstallerLimits();
    out.after_reset = ask('make').status;
    core.ops.saveInstallerLimit(0);
    out.unlimited = [1, 2, 3, 4, 5].map(() => ask('make').status);
    core.ops.saveInstallerLimit(1);
    out.one = { count: core.installer.quota(${JSON.stringify(user)}, core.installerLimits()).left, make: ask('make').status };
    out.bad = ['-1', 'abc', '1001', ''].map((v) => { try { core.ops.saveInstallerLimit(v); return 'accepted'; } catch { return 'refused'; } });
    core.ops.saveInstallerLimit(3);
    core.ops.resetInstallerLimits();
    out.url = ask('make').body.url;
    out.bad_action = ask('nonsense').status;
    // the time runs out, or the account is switched off: no installer
    const db = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(data, 'users.json'))}, 'utf8'));
    db[${JSON.stringify(user)}].expires = Date.now() - 1000;
    require('fs').writeFileSync(${JSON.stringify(join(data, 'users.json'))}, JSON.stringify(db));
    out.expired = ask('make').status;
    out.second_key = redeem(month).body.user.active;
    out.again = core.siteInstaller(cookie, 'make', '8.8.8.8').status;     // another address: one address may only try so often
    core.ops.user(${JSON.stringify(user)}, 'revoke');
    const off = ask('make');
    out.switched_off = { status: off.status, message: off.body.error };
    out.key_when_off = redeem(core.ops.makeKeys('week', 1)[0]).status;
    console.log(JSON.stringify(out));`], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.state_anon.body.user, null, 'a visitor is not logged in');
  assert.equal(out.state_anon.body.ready, true, 'the installer and Grape are there');
  assert.equal(out.make_anon, 401, 'no installer without a login');
  assert.equal(out.redeem_anon, 401, 'and no key without one');
  assert.deepEqual(out.no_time, { status: 403, needs_time: true, active: false }, 'logged in without time: refused, and the popup is told why');
  assert.equal(out.bad_key, 403, 'a key that was never made');
  assert.equal(out.junk_key, 403);
  assert.deepEqual(out.redeemed, { status: 200, active: true, plan: '7 days' }, 'a key gives time, on the website too');
  assert.equal(out.key_twice, 403, 'a key works once');
  assert.equal(out.state_user.body.user.name, 'Popup');
  assert.deepEqual(out.state_user.body.quota, { used: 0, limit: 3, left: 3 });
  assert.deepEqual(out.makes, [200, 200, 200]);
  assert.deepEqual(out.fourth, { status: 429, limit: true, mentions: true, left: 0 }, 'the fourth in a day is refused, with words for the popup');
  assert.equal(out.after_reset, 200, 'a reset lets them make one again');
  assert.deepEqual(out.unlimited, [200, 200, 200, 200, 200], 'a limit of 0 is no limit');
  assert.deepEqual(out.one, { count: 0, make: 429 }, 'a limit of 1 with installers already made today');
  assert.deepEqual(out.bad, ['refused', 'refused', 'refused', 'refused']);
  assert.match(out.url, /^\/get\/[\w-]{32}$/);
  assert.equal(out.bad_action, 400);
  assert.equal(out.expired, 403, 'when the time is up, no more installers');
  assert.equal(out.second_key, true, 'another key brings the account back');
  assert.equal(out.again, 200);
  assert.equal(out.switched_off.status, 403);
  assert.match(out.switched_off.message, /switched off/);
  assert.equal(out.key_when_off, 403, 'a key is not used up for an account that is switched off');
});
