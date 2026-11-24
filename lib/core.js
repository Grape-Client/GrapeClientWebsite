// Grape's server, the core: accounts, keys, Discord logins, the loader's WebSocket protocol, and what the admin page does.
// server.js loads this once and puts it on globalThis.grape, where the Next.js pages and routes find the same instance
// (they never import it: Next bundles its own copies of modules, and this must be the one with the open connections).
//
// The loader carries encrypted injection resources: when Inject is pressed it asks this server, which checks that the
// computer has an active license and hands back the agent sealed for that one injection. Scripts go the same way.
//
// Computers and Discord accounts: a computer registers once (the loader makes a secret and tells the server); that only
// proves which computer is talking. The account is a Discord user: the computer logs in with Discord (OAuth2, the client
// secret stays on this server) and is linked to that user. Time belongs to the Discord user and is added by redeeming
// keys: each key is worth a plan (Weekly, Monthly, ... Lifetime), can be used once, and adds its days to what is left.
//
// One computer per Discord account: the account is locked to the HWID of the first computer that logs in with it. From
// another computer the user can move the lock there ("Reset HWID"), at most once every 24 hours.
//
// Discord: set on the admin page (saved in data/discord.json {"client_id", "client_secret", "redirect_uri"}), or with
// GRAPE_DISCORD_CLIENT_ID, GRAPE_DISCORD_CLIENT_SECRET, GRAPE_DISCORD_REDIRECT_URI. redirect_uri is this server's
// /v1/discord/callback exactly as written in the Discord application's OAuth2 redirects (default: <public url>/v1/discord/callback).
// The public URL is where browsers reach this server: GRAPE_PUBLIC_URL, or the admin page (default http://127.0.0.1:<port>).
//
//   node server.js                        start the server (127.0.0.1:8787; GRAPE_PORT / GRAPE_BIND / GRAPE_DATA change that)
//                                         the admin page is /admin-grape; the website's login pages are / and /link
//   node server.js plans                  the plans and their lengths
//   node server.js genkey <plan> [n] [note]   make n redeemable keys (shown once; the server keeps only their hashes)
//   node server.js keys                   the keys made, and which are used
//   node server.js revoke-key <prefix>    cancel an unused key (its hash prefix, from "keys")
//   node server.js accounts               the registered computers, and the Discord user each is logged in as
//   node server.js users                  the Discord users: plan, time left, the computer they are locked to
//   node server.js grant <id> <plan>      give a user a plan, as if they had redeemed a key
//   node server.js extend <id> <days>     add days (a negative number takes them away)
//   node server.js revoke <id> | unrevoke <id>    switch a user off / on
//   node server.js reset <id>             free a user's HWID lock now (no 24-hour wait): the next computer takes it
//   node server.js link <computer> <discord id> [name]    log a computer in as a Discord user by hand (support, tests)
//   node server.js unlink <computer>      log a computer out
//   <id> is a Discord user id, or a computer's id (then the user it is logged in as).
//
// The protocol (grape-app/src-tauri/src/auth.rs matches it byte for byte). Everything is a message on ONE WebSocket,
// ws://host/v1/ws, and as few as possible: {id, path, ...} -> {id, ...}.
//
//   once ever    /v1/register {id, secret, hwid}      the loader's secret is kept here (https in production)
//   per connection (2 messages):
//     /v1/hello {id, hwid}                    -> {nonce}
//     /v1/auth  {cnonce, proof}               -> {proof, state}      proofs both ways, then both sides hold the keys
//        mk      = HMAC(s, "grape-auth-v2" | nonce | cnonce | hwid)
//        proof   = HMAC(mk, "client") / HMAC(mk, "server")
//        k_req = HMAC(mk,"request"), k_res = HMAC(mk,"response"), k_push = HMAC(mk,"push")
//        state   = the account, sealed with k_push                  (so nothing has to ask for it)
//   then each request is ONE message, sealed (AES-256-GCM): {id, path, n, sealed}, n = 1, 2, 3...
//        request  sealed with k_req, aad = "c" | n | path       -> the body (JSON)
//        answer   {id, sealed} with k_res, aad = "s" | n        -> {status, body}
//     /v1/account                              -> the account (a refresh; it is normally pushed, never asked)
//     /v1/discord/start {via}                  -> {url, code}: the page on this server where the browser logs in. via
//                                                 "discord": straight to Discord, then back to the app (grape://);
//                                                 "website": the account the browser is logged in with here, if any
//     /v1/discord/logout {}                    -> the account, with this computer logged out
//     /v1/reset-hwid {}                        -> the account, locked to this computer now (once every 24 hours)
//     /v1/redeem-key {code}                    -> the account after the key was redeemed (needs a Discord login)
//     /v1/redeem  {link_key}                   -> {agent}: the agent sealed with the link key (needs an active license)
//     /v1/resource-key {}                      -> {key}: opens encrypted client resources (needs an active license)
//     /v1/resource {name}                      -> {data}: the sealed bytes of a named injection resource (stub, dll), opened
//                                                 with the resource key by the loader (needs an active license)
//     /v1/ui-ticket {}                         -> {ticket}: one unlock of the window, for this connection only, 30 s
//     /v1/ui-bundle {ticket}                   -> {bundle}: the window's files, sealed with a key made for this one
//        delivery: HMAC(k_res, "grape-ui-key" | ticket). The ticket is gone once asked for, so each unlock has its
//        own key, the key never crosses the wire, and nothing in the program can open the window by itself
//     /v1/execute {name, sha256, jar}          -> {jar}: the script, issued back (needs an active license)
//   and the server speaks first: {event: "account", reason, sealed} (k_push, aad "p") when the account changes - logged
//   in, a key redeemed, the HWID moved, switched off, granted time, or its time up. The sealed body is the account.
//
//   the browser (Next.js pages): /login/discord?state -> Discord -> /v1/discord/callback -> the computer is linked to that
//   Discord user (pushed to it), the browser is logged in on the website too, and it is sent back to the app: grape://login
//
// Nothing secret crosses the wire after registration, a fake server cannot answer (it lacks s), a recorded exchange is
// useless (fresh keys per connection, a counter on every request), and the agent's plaintext never reaches the loader.

'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DATA = path.resolve(process.env.GRAPE_DATA || path.join(__dirname, '..', 'data'));
const PAYLOAD_ENC = process.env.GRAPE_PAYLOAD_ENC || path.join(__dirname, '..', 'payload', 'grape-agent-core.jar.enc');
const PAYLOAD = process.env.GRAPE_PAYLOAD || PAYLOAD_ENC;
const NAMES_DIR = process.env.GRAPE_NAMES_DIR || path.join(__dirname, '..', 'payload', 'names');
// the other two pieces the loader injects with, sealed with the resource key (scripts/encrypt-agent-jars.mjs, copy-dll.mjs):
// the attach stub (a jar) and the DLL. The loader opens them with the resource key it is given, exactly as it opened the
// copies that used to be built into it - so nothing injection-related sits in the exe any more.
const CLIENT_RESOURCES = {
  stub: process.env.GRAPE_STUB_ENC || path.join(__dirname, '..', 'payload', 'grape-agent.jar.enc'),
  dll: process.env.GRAPE_DLL_ENC || path.join(__dirname, '..', 'payload', 'grape-dll.enc'),
};
// the window of the app (its pages, scripts and styles), made by the app's scripts/build-ui.mjs: never in the program
const UI_BUNDLE = process.env.GRAPE_UI_BUNDLE || path.join(__dirname, '..', 'payload', 'grape-ui.json');
const RESOURCE_KEY_FILE = process.env.GRAPE_RESOURCE_KEY_FILE || path.join(DATA, 'grape-resource.key');
const PORT = Number(process.env.GRAPE_PORT || 8787);
const BIND = process.env.GRAPE_BIND || '127.0.0.1';
const ACCOUNTS = path.join(DATA, 'accounts.json');        // the computers
const USERS = path.join(DATA, 'users.json');              // the Discord users: plan, time, HWID lock
const KEYS = path.join(DATA, 'keys.json');
const HWID_RESET_WAIT = 24 * 3600 * 1000;
const LOGIN_SECONDS = 600;                                 // how long a Discord login link stays good

/** Settings the admin page changes: data/settings.json. */
const SETTINGS = path.join(DATA, 'settings.json');
const DISCORD = path.join(DATA, 'discord.json');

/** Where browsers reach this server (the login pages, the Discord redirect). No trailing slash. */
function publicUrl() {
  const set = process.env.GRAPE_PUBLIC_URL || read(SETTINGS).public_url || `http://127.0.0.1:${PORT}`;
  return String(set).replace(/\/+$/, '');
}

/** The Discord application. Read on every login, so the admin page can change it while the server runs. */
function discordConfig() {
  const file = read(DISCORD);
  const c = {
    client_id: process.env.GRAPE_DISCORD_CLIENT_ID || file.client_id || '',
    client_secret: process.env.GRAPE_DISCORD_CLIENT_SECRET || file.client_secret || '',
    redirect_uri: process.env.GRAPE_DISCORD_REDIRECT_URI || file.redirect_uri || `${publicUrl()}/v1/discord/callback`,
  };
  return c.client_id && c.client_secret ? c : null;
}

const LOG = path.join(DATA, 'server.log');
const SESSION_SECONDS = 30;
const DAY = 86400000;
const AGENT_LABEL = Buffer.from('grape-agent-core');          // matches link::seal_agent

/** What a key can be worth: 7 days or 30 days, and no other plan. (`days: null` would be forever; data/plans.json can add
 *  plans for a test, nothing else does.) An account that already has time from a plan that no longer exists keeps it. */
const PLANS = {
  week: { name: '7 days', days: 7 },
  month: { name: '30 days', days: 30 },
};
/** What the website shows for each plan until the admin saves prices of their own (Settings > Website). */
const DEFAULT_PRICES = { week: '$2', month: '$6' };
try { Object.assign(PLANS, JSON.parse(fs.readFileSync(path.join(DATA, 'plans.json'), 'utf8'))); } catch { /* the built-in plans */ }
/** A plan's name: its own, or - for time that came from a plan that is gone - its id made readable. */
const planName = (id) => (id ? (own(PLANS, id) || {}).name || String(id).charAt(0).toUpperCase() + String(id).slice(1) : 'None');
/** A value by name, only if the object has it itself: a name like "__proto__" or "constructor" must find nothing. */
const own = (obj, key) => (typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined);

// DEVELOPMENT ONLY: /view-process shows what the server receives and what it sends (hex is cut to its first bytes and
// its size; secrets and keys are hidden). Switch it off in production with GRAPE_DEV=0.
// on while developing, off in production (it shows what the server receives): GRAPE_DEV=1 / 0 overrides
const DEV = process.env.GRAPE_DEV ? process.env.GRAPE_DEV !== '0' : process.env.NODE_ENV !== 'production';
const events = [];
const watchers = new Set();
const brief = (value, key) => {
  if (key === 'secret' || key === 'link_key') return '(hidden)';
  if (key === 'code' && typeof value === 'string') return value.slice(0, 9) + '...';
  if (typeof value === 'string' && value.length > 60 && /^[A-Za-z0-9+/=]+$/.test(value) && !/^[0-9a-f]+$/.test(value)) return `${value.slice(0, 10)}... (${value.length} chars of base64, ${Math.floor(value.length * 3 / 4)} bytes)`;
  if (typeof value === 'string') return /^[0-9a-f]{25,}$/.test(value) ? `${value.slice(0, 10)}... (${value.length / 2} bytes)` : value.length > 300 ? value.slice(0, 300) + '...' : value;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, brief(v, k)]));
  return value;
};
function record(entry) {
  if (!DEV) return;
  entry.time = new Date().toISOString();
  events.push(entry);
  if (events.length > 500) events.shift();
  for (const send of watchers) send(entry);
}

const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const hmac = (key, ...parts) => crypto.createHmac('sha256', key).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const idOf = (secret) => sha256('grape-account-id', secret).toString('hex').slice(0, 16);

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** The file's JSON, or {} when the file does not exist yet. A file that exists but cannot be read or parsed is NOT empty:
 *  taking it for {} would make the next change save almost nothing over it - every account, user or key in it gone, and
 *  used keys usable again. Windows says a file is busy for a moment while another process renames it, so it is tried
 *  a few times; after that it is an error and nothing is written. */
function read(file) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; last = e; if (i < 3) sleepMs(25); }
  }
  throw new Error(`${path.basename(file)} could not be read (${last.message}): not changing it`);
}
/** Written whole to a file of its own, flushed to disk, then moved over the old one: a crash leaves the old file. The
 *  temporary name is unique, so the admin commands and the server never write the same one. */
function write(file, db) {
  fs.mkdirSync(DATA, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.saving`;
  const fd = fs.openSync(temp, 'w');
  try { fs.writeSync(fd, JSON.stringify(db, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let i = 0; ; i++) {
    try { fs.renameSync(temp, file); return; } catch (e) {
      if (i >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(temp); } catch { /* gone */ } throw e; }
      sleepMs(25);
    }
  }
}
const accounts = () => read(ACCOUNTS);
const users = () => read(USERS);
const keys = () => read(KEYS);
function log(line) {
  // one line each: a name a user chose (a script's) must not start a line of its own in the log
  const text = new Date().toISOString() + '  ' + String(line).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  console.log(text);
  try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG, text + '\n'); } catch { /* the console has it */ }
}

// the accounts of the first version of this server (a license typed in) do not fit: kept aside, not deleted
try {
  const old = path.join(DATA, 'licenses.json');
  if (fs.existsSync(old) && !fs.existsSync(ACCOUNTS)) fs.renameSync(old, old + '.old');
} catch { /* nothing to move */ }

/** AES-256-GCM as the loader's aes-gcm crate does it: iv(12) | ciphertext | tag(16). */
function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
function open(key, sealed, aad) {
  if (sealed.length < 28) throw new Error('short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
}

// ------------------------------------------------------------------ plans and time

const active = (a) => !a.revoked && !!a.plan && (a.expires === null || a.expires > Date.now());

/** The Discord user a computer is logged in as, or null. */
const userOf = (device, db) => (device && device.user && db[device.user]) || null;
/** Whether this computer may use the user's account: the account is locked to no computer yet, or to this one. */
const hwidOk = (user, hwid) => !user.hwid || user.hwid === hwid;
/** The picture of a Discord user: their own, or the one Discord gives everyone who has not chosen one (picked by their id). */
function avatarOf(id, user) {
  if (user.avatar && /^[\w]+$/.test(String(user.avatar)) && /^\d+$/.test(String(id))) return `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.png?size=64`;
  return /^\d{5,25}$/.test(String(id)) ? `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png` : '';
}

/** What a computer is told about its account: the Discord user's plan and time, and whether this computer holds the
 *  account's HWID lock. `active` is true only when everything is in order for this computer. */
function describe(id, device, db) {
  const user = userOf(device, db || users());
  const a = user || {};
  const plan = own(PLANS, a.plan);
  const here = !user || hwidOk(user, device.hwid);
  return {
    id,
    discord: user ? { id: device.user, name: user.global_name || user.username || 'Discord user', username: user.username || '', avatar: avatarOf(device.user, user) } : null,
    plan: a.plan || null,
    plan_name: plan ? plan.name : a.plan ? a.plan : 'None',
    active: !!user && here && !device.revoked && active(a),
    revoked: !!a.revoked || !!device.revoked,
    hwid_ok: here,                       // false: the account is locked to another computer
    hwid_bound: !!a.hwid,
    next_reset: user ? (user.hwid_reset_at || 0) + HWID_RESET_WAIT : 0,     // when Reset HWID can be used (ms)
    expires: user ? a.expires : 0,       // ms since 1970, null = never
    now: Date.now(),
    created: a.created || device.created,
    redeemed: (a.redeemed || []).slice(-10).map((r) => ({ plan: r.plan, plan_name: planName(r.plan), at: r.at })),
  };
}

/** A user without a lock takes this computer's HWID. Returns true when it changed (the caller writes). */
function claim(user, hwid) {
  if (user.hwid || !hwid) return false;
  user.hwid = hwid;
  user.hwid_set_at = Date.now();
  return true;
}

/** Logs a computer in as a Discord user. A computer that had time of its own (from before Discord logins) hands it to
 *  a user who has none. Writes both files. */
function link(deviceId, discordId, profile) {
  const devices = accounts(), db = users();
  const device = devices[deviceId];
  if (!device) throw new Error('No computer with that id.');
  const user = db[discordId] || (db[discordId] = { plan: null, expires: 0, revoked: false, hwid: null, hwid_set_at: 0, hwid_reset_at: 0, created: Date.now(), uses: 0, redeemed: [] });
  Object.assign(user, { username: profile.username || user.username || '', global_name: profile.global_name || user.global_name || '', avatar: profile.avatar === undefined ? user.avatar || '' : profile.avatar || '' });
  if (device.plan && !user.plan) {
    Object.assign(user, { plan: device.plan, expires: device.expires, redeemed: [...(user.redeemed || []), ...(device.redeemed || [])] });
    log(`link: ${deviceId} handed its ${device.plan} time to ${discordId}`);
  }
  if (device.plan) Object.assign(device, { plan: null, expires: 0, carried_to: discordId });
  device.user = discordId;
  claim(user, device.hwid);
  write(USERS, db);
  write(ACCOUNTS, devices);
  log(`link: computer ${deviceId} logged in as ${discordId} (${user.username})${hwidOk(user, device.hwid) ? '' : ' - locked to another computer'}`);
}

/** Adds a plan's time to an account: from what is left if it is still running, otherwise from now. Returns a problem or ''. */
function addPlan(account, planId) {
  const plan = own(PLANS, planId);
  if (!plan) return 'That plan does not exist.';
  if (account.plan && account.expires === null) return 'You already have a lifetime license.';
  if (plan.days === null) account.expires = null;
  else account.expires = Math.max(Date.now(), account.expires || 0) + plan.days * DAY;
  account.plan = planId;
  (account.redeemed = account.redeemed || []).push({ plan: planId, at: Date.now() });
  return '';
}

const keyHash = (code) => sha256('grape-key-v1', code).toString('hex');
/** "grape-abcde fghij..." -> "GRAPEABCDEFGHIJ...": what the hash is made of, so dashes and case do not matter. */
const normalise = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ------------------------------------------------------------------ the server

const recent = new Map();           // account id -> [times of its last requests]
const failures = new Map();         // client address -> [times of its last failures]
const guesses = new Map();          // account id -> [times of its last wrong keys]
const registrations = new Map();    // client address -> [times of its last registrations]
const webhits = new Map();          // client address -> [times of its last requests to the login and download pages]

/** Whether `key` has already used up `limit` in the last `seconds`, without counting this look. */
function blocked(map, key, limit, seconds) {
  const now = Date.now();
  return (map.get(key) || []).filter((t) => now - t < seconds * 1000).length >= limit;
}

function tooMany(map, key, limit, seconds) {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < seconds * 1000);
  list.push(now);
  map.set(key, list);
  return list.length > limit;
}

// ---- what the admin hears about, and which copies of Grape are let in

const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const alertedAt = new Map();
/** Tells the admin something happened (a Discord webhook message), at most one of each kind in five minutes. Never throws:
 *  an alert that cannot be sent is only in the log. */
function alert(kind, text) {
  try {
    const hook = String(process.env.GRAPE_ALERT_WEBHOOK || read(SETTINGS).alert_webhook || '');
    if (!WEBHOOK.test(hook)) return;
    if (Date.now() - (alertedAt.get(kind) || 0) < 5 * 60 * 1000) return;
    alertedAt.set(kind, Date.now());
    fetch(hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: ('Grape server: ' + text).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 1800), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  } catch { /* it is in the log */ }
}
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
/** a < b for versions like 1.2.3. */
function olderThan(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
/** Why this copy of Grape is turned away at the door (a version below the admin's minimum, a build the server does not
 *  know once that is asked for), or null. What the copy says about itself can be false: this keeps out old ones and
 *  careless changes, it is not a lock against someone who patches the program on purpose. */
function refuseBuild(body) {
  const s = read(SETTINGS);
  const version = typeof body.version === 'string' && VERSION.test(body.version) ? body.version : '';
  const min = typeof s.min_version === 'string' && VERSION.test(s.min_version) ? s.min_version : '';
  if (min && (!version || olderThan(version, min))) return { say: `This version of Grape is too old (${version || 'unknown'}). Install ${min} or newer: get a new installer.`, why: `version ${version || '?'} is below ${min}` };
  if (s.require_build === true) {
    const build = typeof body.build === 'string' && /^[0-9a-f]{64}$/.test(body.build) ? body.build : '';
    const known = new Set([...(Array.isArray(s.known_builds) ? s.known_builds : []), installer.status().app_sha256]);
    known.delete('');
    if (!build || !known.has(build)) return { say: 'This copy of Grape is not an official build. Install it again with a new installer.', why: `unknown build ${build.slice(0, 12) || '?'}` };
  }
  return null;
}

// the admin page may be limited to some addresses (data/settings.json "admin_ips", or GRAPE_ADMIN_IPS)
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
function adminIps() {
  const raw = process.env.GRAPE_ADMIN_IPS || String(read(SETTINGS).admin_ips || '');
  return raw.split(/[\s,;]+/).map(cleanIp).filter(Boolean);
}
const adminAllowed = (ip) => { const list = adminIps(); return !list.length || list.includes(cleanIp(ip)); };

const hexOf = (value, length) => (typeof value === 'string' && value.length === length * 2 && /^[0-9a-f]+$/.test(value) ? Buffer.from(value, 'hex') : null);
const hwidOf = (value) => (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : '');
const b64 = (buffer) => Buffer.from(buffer).toString('base64');
const unb64 = (text) => Buffer.from(typeof text === 'string' ? text : '', 'base64');
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const NOT_REGISTERED = 'This computer is not registered with the server yet.';

/** A computer says it exists: the loader's secret is kept here, tied to the computer. Safe to say again. */
function register(body, from) {
  const id = typeof body.id === 'string' ? body.id : '';
  const secret = hexOf(body.secret, 32);
  const hwid = hwidOf(body.hwid);
  if (!secret || !hwid || idOf(secret) !== id) return [400, 'Bad request.'];
  if (tooMany(registrations, from, 20, 3600)) return [429, 'Too many registrations from here. Try later.'];
  const db = accounts();
  const found = db[id];
  if (found) {
    if (!same(Buffer.from(found.secret, 'hex'), secret)) return [409, 'That account already exists with another secret.'];
    // the secret proves it is the same computer; its hardware id may have changed (a new id formula in a new Grape, a
    // new disk). What limits an account to one computer is the Discord user's lock, not this.
    if (found.hwid !== hwid) { found.hwid = hwid; write(ACCOUNTS, db); }
    return [200, { registered: true, existing: true }];
  }
  db[id] = { secret: secret.toString('hex'), hwid, plan: null, expires: 0, revoked: false, created: Date.now(), uses: 0, redeemed: [] };
  write(ACCOUNTS, db);
  log(`register: new account ${id} from ${from}`);
  return [200, { registered: true, existing: false }];
}

/** Message 1 of a connection: who is asking. */
function hello(conn, body, from) {
  const id = typeof body.id === 'string' ? body.id : '';
  const hwid = hwidOf(body.hwid);
  if (!hwid || !/^[0-9a-f]{16}$/.test(id)) return [400, 'Bad request.'];
  if (tooMany(failures, from, 30, 60)) { alert('ratelimit', `${from} is asking the server too often.`); return [429, 'Too many tries. Wait a minute.']; }
  const refused = refuseBuild(body);
  if (refused) { log(`hello: ${id} turned away: ${refused.why}`); return [426, refused.say]; }
  const account = accounts()[id];
  if (!account) { tooMany(failures, from, 30, 60); return [404, NOT_REGISTERED]; }
  if (account.revoked) { log(`hello: ${id} is switched off`); return [403, 'This account has been switched off.']; }
  conn.hello = { id, hwid, nonce: crypto.randomBytes(32), at: Date.now() };
  return [200, { nonce: conn.hello.nonce.toString('hex') }];
}

/** Message 2: the proofs, both ways. From here the connection holds its keys and every request is one sealed message. */
function authenticate(conn, body, from) {
  const h = conn.hello;
  conn.hello = null;                                     // single use, whatever happens next
  const cnonce = hexOf(body.cnonce, 16), proof = hexOf(body.proof, 32);
  if (!h || Date.now() - h.at > SESSION_SECONDS * 1000 || !cnonce || !proof) return [403, 'That handshake is not valid (it may have timed out). Try again.'];
  const account = accounts()[h.id];
  if (!account || account.revoked) return [403, 'This account has been switched off.'];
  const mk = hmac(Buffer.from(account.secret, 'hex'), 'grape-auth-v2', h.nonce, cnonce, h.hwid);
  if (!same(hmac(mk, 'client'), proof)) { tooMany(failures, from, 30, 60); log(`wrong proof for ${h.id} from ${from}`); return [403, 'The secret does not match.']; }
  if (account.hwid !== h.hwid) {                         // proven by the secret: keep the computer's current hardware id
    const db = accounts();
    if (db[h.id]) { db[h.id].hwid = h.hwid; write(ACCOUNTS, db); }
    log(`hwid: computer ${h.id} presented a new hardware id (kept)`);
  }
  Object.assign(conn, { id: h.id, hwid: h.hwid, kReq: hmac(mk, 'request'), kRes: hmac(mk, 'response'), kPush: hmac(mk, 'push'), rx: 0, ready: true });
  bind(conn, h.id);
  return [200, { proof: hmac(mk, 'server').toString('hex'), state: b64(seal(conn.kPush, Buffer.from(JSON.stringify(describe(h.id, account))), Buffer.from('a'))) }];
}

const NOT_LOGGED_IN = 'Log in with Discord in Settings > Account first.';
const OTHER_COMPUTER = 'Your Discord account is locked to another computer. Reset the HWID in Settings > Account (once every 24 hours).';

/** Why this computer may not use the app now, or '' when it may. */
function needsLicense(ctx) {
  const u = ctx.user;
  if (!u) return NOT_LOGGED_IN;
  if (u.revoked) return 'This account has been switched off.';
  if (!hwidOk(u, ctx.conn.hwid)) return OTHER_COMPUTER;
  if (active(u)) return '';
  return u.plan ? 'Your license has expired. Redeem a new key in Settings > Account.' : 'No active license. Redeem a key in Settings > Account.';
}

/** Counts a use of the account (what the admin list shows). */
function used(ctx) {
  ctx.user.uses = (ctx.user.uses || 0) + 1;
  ctx.user.last = Date.now();
  write(USERS, ctx.users);
}

// The sealed requests. Each gets what the connection already proved: who it is, and the account as it is now.

function accountInfo(ctx) {
  return [200, describe(ctx.id, ctx.account, ctx.users)];
}

// Discord logins waiting for the browser to come back: state -> {device, at}. Each is used once.
const logins = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // no I, O, 0 or 1: nothing to misread

/** Starts a login for this computer. The browser goes to this server first (never straight to Discord from the app):
 *  "discord" sends it on to Discord, "website" uses the account the browser is already logged in with here. The code
 *  is shown in the app and on the page, so the user can see the page belongs to their own login. */
function discordStart(ctx, body) {
  if (!discordConfig()) return [503, 'Discord login is not set up on the server yet.'];
  if (tooMany(guesses, 'login:' + ctx.id, 10, 600)) return [429, 'Too many logins started. Wait a few minutes.'];
  sweepLogins();
  if (logins.size > 5000) return [429, 'The server is busy with logins. Try again in a few minutes.'];
  const via = body && body.via === 'website' ? 'website' : 'discord';
  const state = crypto.randomBytes(24).toString('hex');
  let code = '';
  while (code.length < 4) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  logins.set(state, { device: ctx.id, at: Date.now(), via, code });
  return [200, { url: `${publicUrl()}/${via === 'website' ? 'link' : 'login/discord'}?state=${state}`, code }];
}

let lastSweep = 0;
function sweepLogins() {
  if (Date.now() - lastSweep < 30000) return;           // not on every request: the map can be large
  lastSweep = Date.now();
  for (const [s, l] of logins) if (Date.now() - l.at > LOGIN_SECONDS * 1000) logins.delete(s);
}

function discordLogout(ctx) {
  if (ctx.account.user) {
    log(`logout: computer ${ctx.id} logged out of ${ctx.account.user}`);
    delete ctx.account.user;
    write(ACCOUNTS, ctx.db);
  }
  return [200, describe(ctx.id, ctx.account, ctx.users)];
}

/** Moves the account's HWID lock to this computer: once every 24 hours. */
function resetHwid(ctx) {
  const u = ctx.user;
  if (!u) return [403, NOT_LOGGED_IN];
  if (u.hwid === ctx.conn.hwid) return [409, 'Your account is already locked to this computer.'];
  const wait = (u.hwid_reset_at || 0) + HWID_RESET_WAIT - Date.now();
  if (wait > 0) {
    const h = Math.floor(wait / 3600000), m = Math.ceil((wait % 3600000) / 60000);
    return [429, `You can reset your HWID again in ${h ? h + 'h ' : ''}${m}m.`];
  }
  Object.assign(u, { hwid: ctx.conn.hwid, hwid_set_at: Date.now(), hwid_reset_at: Date.now() });
  write(USERS, ctx.users);
  log(`reset-hwid: ${ctx.account.user} moved its lock to computer ${ctx.id}`);
  return [200, describe(ctx.id, ctx.account, ctx.users)];
}

function redeemKey(ctx, body) {
  if (!ctx.user) return [403, NOT_LOGGED_IN];
  if (ctx.user.revoked) return [403, 'This account has been switched off.'];          // a key must not be used up for nothing
  if (tooMany(guesses, ctx.id, 8, 60)) { alert('guess', `Computer ${ctx.id} is trying many keys.`); return [429, 'Too many keys tried. Wait a minute.']; }
  const normal = normalise(body.code);
  const db = keys();
  const key = normal.length === 25 && normal.startsWith('GRAPE') ? db[keyHash(normal)] : null;
  if (!key || key.revoked) { log(`redeem-key: ${ctx.id} tried a key that does not exist`); return [403, 'That key is not valid.']; }
  if (key.used_by) { log(`redeem-key: ${ctx.id} tried a key that was used`); return [403, 'That key has already been used.']; }
  const problem = addPlan(ctx.user, key.plan);
  if (problem) return [409, problem];
  key.used_by = ctx.account.user;                       // the Discord user: a key is used once, by one account
  key.used_by_computer = ctx.id;
  key.used_at = Date.now();
  write(KEYS, db);
  try {
    write(USERS, ctx.users);
  } catch (e) {                                          // the user got no time: the key is not used up
    key.used_by = null; key.used_by_computer = null; key.used_at = null;
    try { write(KEYS, db); } catch { /* the log below says it */ }
    log(`redeem-key: could not save the time for ${ctx.account.user}, the key was given back (${e.message})`);
    return [500, 'The key could not be redeemed, and was not used up. Try again.'];
  }
  log(`redeem-key: ${ctx.account.user} (computer ${ctx.id}) redeemed a ${key.plan} key, now until ${ctx.user.expires === null ? 'forever' : new Date(ctx.user.expires).toISOString()}`);
  return [200, describe(ctx.id, ctx.account, ctx.users)];
}

function hasPayload() {
  return fs.existsSync(PAYLOAD_ENC) || fs.existsSync(PAYLOAD);
}

function readAgentPayload() {
  if (fs.existsSync(PAYLOAD_ENC)) {
    const sealed = fs.readFileSync(PAYLOAD_ENC);
    const rkey = fs.readFileSync(RESOURCE_KEY_FILE);
    if (rkey.length !== 32) throw new Error('bad resource key');
    return open(rkey, sealed, Buffer.from('grape-agent-core-resource-v1'));
  }
  const raw = fs.readFileSync(PAYLOAD);
  if (raw.length >= 28 && raw.subarray(0, 2).toString('utf8') !== 'PK' && fs.existsSync(RESOURCE_KEY_FILE)) {
    const rkey = fs.readFileSync(RESOURCE_KEY_FILE);
    if (rkey.length === 32) return open(rkey, raw, Buffer.from('grape-agent-core-resource-v1'));
  }
  return raw;
}

function redeem(ctx, body) {
  const need = needsLicense(ctx);
  if (need) return [403, need];
  const linkKey = unb64(body.link_key);
  if (linkKey.length !== 32) return [400, 'Bad request.'];
  let agent;
  try { agent = readAgentPayload(); } catch { log('payload missing: ' + PAYLOAD); return [503, 'The server has no agent to send.']; }
  used(ctx);
  log(`agent: ${ctx.account.user} on ${ctx.id} (${ctx.user.plan}) got the agent (${agent.length} bytes), use ${ctx.user.uses}`);
  return [200, { agent: b64(seal(linkKey, agent, AGENT_LABEL)) }];       // the stub opens it inside the game with the link key
}

/** Serves the obfuscated Minecraft version mapping table for plain vanilla games, only to an active-license session. */
function gameNames(ctx, body) {
  const need = needsLicense(ctx);
  if (need) return [403, need];
  const version = typeof body.version === 'string' && /^\d+(?:\.\d+){1,3}$/.test(body.version.trim()) ? body.version.trim() : '';
  if (!version) return [400, 'Bad version.'];
  const file = path.join(NAMES_DIR, `${version}.txt`);
  if (!fs.existsSync(file)) return [404, `No name table for Minecraft ${version}.`];
  try {
    const table = fs.readFileSync(file, 'utf8');
    return [200, { version, table }];
  } catch {
    return [503, 'Could not read the name table.'];
  }
}

/** Releases the client resource decryption key only inside an authenticated, active-license session. */
function resourceKey(ctx) {
  const need = needsLicense(ctx);
  if (need) return [403, need];
  let key;
  try { key = fs.readFileSync(RESOURCE_KEY_FILE); } catch { log('resource key missing: ' + RESOURCE_KEY_FILE); return [503, 'The server is not configured to issue client resources.']; }
  if (key.length !== 32) { log('resource key has the wrong size: ' + RESOURCE_KEY_FILE); return [503, 'The server is not configured to issue client resources.']; }
  used(ctx);
  log(`resource-key: ${ctx.account.user} on ${ctx.id} (${ctx.user.plan}) received the client resource key`);
  return [200, { key: b64(key) }];
}

/** One of the loader's injection resources by name (the attach stub, or the DLL), as the sealed .enc bytes - the loader opens
 *  them with the resource key it was given. Only inside an authenticated, active-license session. */
function clientResource(ctx, body) {
  const need = needsLicense(ctx);
  if (need) return [403, need];
  const which = typeof body.name === 'string' && Object.hasOwn(CLIENT_RESOURCES, body.name) ? body.name : '';
  if (!which) return [400, 'Unknown resource.'];
  let sealed;
  try { sealed = fs.readFileSync(CLIENT_RESOURCES[which]); } catch { log('client resource missing: ' + CLIENT_RESOURCES[which]); return [503, 'The server does not have that client resource.']; }
  if (sealed.length < 28) { log('client resource too small: ' + CLIENT_RESOURCES[which]); return [503, 'The server does not have that client resource.']; }
  used(ctx);
  log(`resource: ${ctx.account.user} on ${ctx.id} (${ctx.user.plan}) got the ${which} (${sealed.length} bytes)`);
  return [200, { data: b64(sealed) }];
}

/** A script the loader compiled: checked against its hash, then issued back (the place to obfuscate it later). */
function execute(ctx, body) {
  const need = needsLicense(ctx);
  if (need) return [403, need];
  const jar = unb64(body.jar);
  const name = typeof body.name === 'string' && body.name.length <= 100 ? body.name : '';
  if (!name || jar.length < 4 || jar.length > 32 * 1024 * 1024) return [400, 'Bad request.'];
  if (sha256('grape-script-v1', name, jar).toString('hex') !== body.sha256) return [400, 'The script does not match its hash.'];
  if (jar.subarray(0, 4).toString('hex') !== '504b0304') return [400, 'That is not a jar.'];
  used(ctx);
  log(`execute: ${ctx.account.user} on ${ctx.id} script ${name} (${jar.length} bytes)`);
  return [200, { jar: b64(jar) }];
}

// ------------------------------------------------------------------ the window, one unlock at a time

const UI_LABEL = Buffer.from('grape-ui-v2');
const TICKET_SECONDS = 30;
const tickets = new Map();          // ticket (hex) -> { conn, at }: each one good once, on the connection it was made for

/** Step 1 of an unlock: a ticket for this connection. Only a computer that may use Grape gets one. */
function uiTicket(ctx) {
  const need = needsLicense(ctx);
  if (need) return [403, need];
  if (!fs.existsSync(UI_BUNDLE)) { log('window bundle missing: ' + UI_BUNDLE); return [503, 'The server has no Grape window to send (payload/grape-ui.json).']; }
  for (const [t, v] of tickets) if (Date.now() - v.at > TICKET_SECONDS * 1000 || v.conn.sock.destroyed) tickets.delete(t);
  if ([...tickets.values()].filter((v) => v.conn === ctx.conn).length >= 4) return [429, 'Too many unlocks at once.'];
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, { conn: ctx.conn, at: Date.now() });
  return [200, { ticket }];
}

/** Step 2: the ticket back, once. The window comes sealed with a key made from this connection's secret and the
 *  ticket: both sides make it, it is never sent, and it opens only this one delivery. */
function uiBundle(ctx, body) {
  const ticket = typeof body.ticket === 'string' && /^[0-9a-f]{64}$/.test(body.ticket) ? body.ticket : '';
  const entry = ticket ? tickets.get(ticket) : null;
  tickets.delete(ticket);                                // used once, whatever happens next
  if (!entry || entry.conn !== ctx.conn || Date.now() - entry.at > TICKET_SECONDS * 1000) {
    log(`ui: ${ctx.id} sent a ticket that is not good (used, timed out, or another connection's)`);
    return [403, 'That unlock is not valid any more. Start Grape again.'];
  }
  const need = needsLicense(ctx);
  if (need) return [403, need];
  let plain;
  try { plain = fs.readFileSync(UI_BUNDLE); } catch { return [503, 'The server has no Grape window to send (payload/grape-ui.json).']; }
  const key = hmac(ctx.conn.kRes, 'grape-ui-key', Buffer.from(ticket, 'hex'));
  log(`ui: ${ctx.account.user} on ${ctx.id} unlocked the window (${Math.round(plain.length / 1024)} KB, its own key)`);
  return [200, { bundle: b64(seal(key, plain, UI_LABEL)) }];
}

const SECURE = {
  '/v1/account': accountInfo, '/v1/redeem-key': redeemKey, '/v1/redeem': redeem, '/v1/resource-key': resourceKey, '/v1/execute': execute,
  '/v1/game-names': gameNames, '/v1/resource': clientResource,
  '/v1/discord/start': discordStart, '/v1/discord/logout': discordLogout, '/v1/reset-hwid': resetHwid,
  '/v1/ui-ticket': uiTicket, '/v1/ui-bundle': uiBundle,
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>Grape server</title>
<style>
body{margin:0;background:#0e0e0e;color:#e8e8e8;font:13px/1.45 "Segoe UI",system-ui,sans-serif}
header{position:sticky;top:0;background:#0e0e0e;border-bottom:1px solid #222;padding:14px 22px;display:flex;align-items:center;gap:14px}
h1{margin:0;font-size:17px}.dev{font-size:11px;font-weight:700;letter-spacing:.5px;background:#3a2a10;color:#f0b050;border-radius:6px;padding:3px 8px}
button{background:#232323;color:#e8e8e8;border:0;border-radius:8px;padding:6px 12px;cursor:pointer}button:hover{background:#2e2e2e}
.grow{flex:1}#n{color:#888}
.row{border-bottom:1px solid #191919;padding:10px 22px}.top{display:flex;gap:14px;align-items:baseline;cursor:pointer}
.t{color:#777;font:12px Consolas,monospace}.u{font-weight:600}.ok{color:#46d389}.bad{color:#ef6b70}.ms{color:#777}
.body{display:none;gap:18px;margin-top:10px}.row.open .body{display:flex}.col{flex:1;min-width:0}
.col b{display:block;font-size:11px;letter-spacing:.6px;color:#999;margin-bottom:4px}
pre{margin:0;background:#151515;border-radius:10px;padding:12px;font:12px Consolas,monospace;white-space:pre-wrap;word-break:break-all}
</style>
<header><h1>Grape server</h1><span class="dev">DEVELOPMENT ONLY</span><span id="n"></span><span class="grow"></span><button id="clear">Clear</button></header>
<div id="list"></div>
<script>
const list=document.getElementById('list'),n=document.getElementById('n');let count=0;
function add(e,first){count++;n.textContent=count+' requests';const r=document.createElement('div');r.className='row';
const ok=e.status===200;r.innerHTML='<div class="top"><span class="t"></span><span class="u"></span><span></span><span class="ms"></span></div><div class="body"><div class="col"><b>RECEIVED</b><pre></pre></div><div class="col"><b>SENT</b><pre></pre></div></div>';
const s=r.querySelectorAll('.top span');s[0].textContent=e.time.slice(11,23);s[1].textContent=e.method+' '+e.url;s[2].textContent=e.status;s[2].className=ok?'ok':'bad';s[3].textContent=e.ms+' ms  from '+e.from;
const p=r.querySelectorAll('pre');p[0].textContent=JSON.stringify(e.request,null,2);p[1].textContent=JSON.stringify(e.response,null,2);
r.querySelector('.top').onclick=()=>r.classList.toggle('open');first?list.append(r):list.prepend(r)}
fetch('/view-process/events').then(r=>r.json()).then(a=>a.forEach(e=>add(e,true)));
new EventSource('/view-process/stream').onmessage=m=>add(JSON.parse(m.data),false);
document.getElementById('clear').onclick=()=>{list.textContent='';count=0;n.textContent=''};
</script>`;

/** The development viewer. Only for this computer's own address (a web page elsewhere cannot read it). */
function viewer(req, res, reply) {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return reply(403, 'Local only.');
  const url = req.url.split('?')[0];
  if (url === '/view-process' || url === '/view-process/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE); }
  if (url === '/view-process/events') return reply(200, events);
  if (url === '/view-process/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const send = (entry) => res.write('data: ' + JSON.stringify(entry) + '\n\n');
    watchers.add(send);
    req.on('close', () => watchers.delete(send));
    return;
  }
  return reply(404, 'Not found.');
}


// ------------------------------------------------------------------ the WebSocket: one connection that stays open

// Requests ride one WebSocket (/v1/ws) instead of one HTTP request each, and the server can speak first: when an account
// changes (a key redeemed, switched off, its time up) every connection of that account is told at once - no polling.
// A message from the loader is {id, path, body}; the answer is {id, status, body}; a push is {event: "changed", reason}.
// A push is only a hint: the loader asks again, with proofs, what the account is now.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 80 * 1024 * 1024;          // a script's jar, in hex, comes with Execute
const MAX_SMALL = 8192;                        // everything else is small
const PRE_LOGIN_MAX = 16 * 1024;               // before the handshake is done a connection may buffer this much, no more
const capOf = (conn) => (conn.ready ? MAX_MESSAGE : PRE_LOGIN_MAX);
const connections = new Set();
const byAccount = new Map();                   // account id -> its connections
const expiry = new Map();                      // account id -> the timer that says when its time is up
let known = new Map();                         // account id -> what the last look at accounts.json saw

function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}
function send(conn, opcode, payload) { if (!conn.sock.destroyed) conn.sock.write(frame(opcode, payload)); }
function sendJson(conn, value) { send(conn, 1, Buffer.from(JSON.stringify(value))); }
function closeWith(conn, code, why) {
  const reason = Buffer.from(why || '');
  const body = Buffer.alloc(2 + reason.length);
  body.writeUInt16BE(code);
  reason.copy(body, 2);
  try { send(conn, 8, body); conn.sock.end(); } catch { conn.sock.destroy(); }
}

function peek(conn, n) {
  if (conn.have < n) return null;
  const parts = [];
  let need = n;
  for (const c of conn.chunks) { parts.push(c.subarray(0, need)); need -= Math.min(need, c.length); if (!need) break; }
  return Buffer.concat(parts);
}
function pull(conn, n) {
  let out;
  const first = conn.chunks[0];
  if (first && first.length >= n) {
    out = first.subarray(0, n);
    if (first.length === n) conn.chunks.shift(); else conn.chunks[0] = first.subarray(n);
  } else {
    const parts = [];
    let need = n;
    while (need > 0) {
      const c = conn.chunks[0];
      if (c.length <= need) { parts.push(c); need -= c.length; conn.chunks.shift(); } else { parts.push(c.subarray(0, need)); conn.chunks[0] = c.subarray(need); need = 0; }
    }
    out = Buffer.concat(parts);
  }
  conn.have -= n;
  return out;
}

/** Reads as many whole frames as have arrived. */
function parse(conn) {
  for (;;) {
    const head = peek(conn, Math.min(conn.have, 14));
    if (!head || head.length < 2) return;
    const op = head[0] & 15, fin = (head[0] & 0x80) !== 0, masked = (head[1] & 0x80) !== 0;
    let len = head[1] & 127, at = 2;
    if (len === 126) { if (head.length < 4) return; len = head.readUInt16BE(2); at = 4; }
    else if (len === 127) { if (head.length < 10) return; const big = head.readBigUInt64BE(2); if (big > BigInt(capOf(conn))) return closeWith(conn, 1009, 'too big'); len = Number(big); at = 10; }
    if (!masked) return closeWith(conn, 1002, 'client frames must be masked');
    if (op >= 8 && (len > 125 || !fin)) return closeWith(conn, 1002, 'bad control frame');
    if (conn.have < at + 4 + len) return;                 // the rest is still on its way
    pull(conn, at);
    const mask = pull(conn, 4);
    const data = pull(conn, len);
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    if (op === 8) return closeWith(conn, 1000, '');
    if (op === 9) { send(conn, 10, data); continue; }
    if (op === 10) { conn.alive = true; continue; }
    if (op === 1 || op === 2 || op === 0) {
      if (op !== 0) { conn.frag = []; conn.fragSize = 0; conn.fragOp = op; } else if (!conn.frag) return closeWith(conn, 1002, 'unexpected continuation');
      conn.fragSize += data.length;
      if (conn.fragSize > capOf(conn)) return closeWith(conn, 1009, 'too big');
      conn.frag.push(data);
      if (fin) {
        const message = Buffer.concat(conn.frag);
        const opcode = conn.fragOp;
        conn.frag = null;
        if (opcode === 1) message_(conn, message.toString('utf8'));
      }
      continue;
    }
    return closeWith(conn, 1002, 'unknown opcode');
  }
}

/** One message of the loader. The handshake and registration are plain; everything after is sealed. */
function message_(conn, text) {
  let m;
  try { m = JSON.parse(text); } catch { return closeWith(conn, 1007, 'not json'); }
  if (!m || typeof m !== 'object' || (typeof m.id !== 'number' && typeof m.id !== 'string') || String(m.id).length > 40 || typeof m.path !== 'string') return closeWith(conn, 1008, 'bad message');
  if (m.path !== '/v1/execute' && text.length > MAX_SMALL) return sendJson(conn, { id: m.id, status: 400, body: { error: 'Bad request.' } });
  const plain = (status, body) => sendJson(conn, { id: m.id, status, body: typeof body === 'string' ? { error: body } : body });
  const started = Date.now();
  try {
    if (SECURE[m.path]) return secure(conn, m, started);
    const open_ = { '/v1/register': (b) => register(b, conn.from), '/v1/hello': (b) => hello(conn, b, conn.from), '/v1/auth': (b) => authenticate(conn, b, conn.from) }[m.path];
    if (!open_ || !m.body || typeof m.body !== 'object') return plain(404, 'Not found.');
    const [code, out] = open_(m.body);
    record({ from: conn.from, method: 'WS', url: m.path, request: brief(m.body), status: code, response: brief(typeof out === 'string' ? { error: out } : out), ms: Date.now() - started });
    plain(code, out);
  } catch (e) {
    log('error: ' + (e && e.stack || e));
    plain(500, 'The server had a problem.');
  }
}

/** A sealed request: opened with the connection's key, answered sealed, one message each way. */
function secure(conn, m, started) {
  if (!conn.ready) return sendJson(conn, { id: m.id, status: 403, body: { error: 'Not authenticated: start a new handshake.' } });
  if (!Number.isSafeInteger(m.n) || m.n <= conn.rx || typeof m.sealed !== 'string') return closeWith(conn, 1008, 'bad counter');
  let body;
  try { body = JSON.parse(open(conn.kReq, unb64(m.sealed), Buffer.concat([Buffer.from('c'), u64(m.n), Buffer.from(m.path)])).toString('utf8')); } catch { return closeWith(conn, 1008, 'bad seal'); }
  conn.rx = m.n;
  const db = accounts();
  const account = db[conn.id];
  const userDb = users();
  const user = userOf(account, userDb);
  // a user whose lock was freed (by the admin) takes the first of its computers that asks for something
  if (user && claim(user, conn.hwid)) { write(USERS, userDb); log(`hwid: ${account.user} locked to computer ${conn.id}`); }
  let code, out;
  if (!account) [code, out] = [404, NOT_REGISTERED];
  else if (account.revoked) [code, out] = [403, 'This account has been switched off.'];
  else if (tooMany(recent, conn.id, 120, 60)) [code, out] = [429, 'Too many requests for this account. Wait a minute.'];
  else [code, out] = SECURE[m.path]({ conn, id: conn.id, db, account, users: userDb, user }, body || {});
  const answer = { status: code, body: typeof out === 'string' ? { error: out } : out };
  record({ from: conn.from, method: 'WS', url: m.path + '  #' + m.n, request: brief(body), status: code, response: brief(answer.body), ms: Date.now() - started });
  sendJson(conn, { id: m.id, sealed: b64(seal(conn.kRes, Buffer.from(JSON.stringify(answer)), Buffer.concat([Buffer.from('s'), u64(m.n)]))) });
}

function bind(conn, id) {
  if (typeof id !== 'string' || conn.account === id) return;
  if (conn.account) byAccount.get(conn.account)?.delete(conn);
  conn.account = id;
  if (!byAccount.has(id)) byAccount.set(id, new Set());
  byAccount.get(id).add(conn);
  arm(id);
}

/** Tells every open connection of an account what it is now: the account itself, sealed, so nothing has to ask for it. */
function notify(id, reason) {
  const list = byAccount.get(id);
  const account = accounts()[id];
  const state = account ? describe(id, account, users()) : null;
  record({ from: 'server', method: 'PUSH', url: reason, request: { account: id }, status: 200, response: { to: list ? list.size : 0, state }, ms: 0 });
  if (!list || !state) return;
  for (const conn of list) if (conn.ready) sendJson(conn, { event: 'account', reason, sealed: b64(seal(conn.kPush, Buffer.from(JSON.stringify(state)), Buffer.from('p'))) });
}

/** When an account's time is up, its connections hear it at that moment: nothing has to ask. */
function arm(id) {
  clearTimeout(expiry.get(id));
  expiry.delete(id);
  const a = userOf(accounts()[id], users());          // the time is the Discord user's
  if (!a || a.revoked || !a.plan || a.expires === null) return;
  const wait = a.expires - Date.now() + 300;
  if (wait <= 0) return;
  // setTimeout cannot wait longer than 2^31-1 ms (24.8 days): a monthly plan is waited for in steps
  const step = Math.min(wait, 2 ** 31 - 1);
  const timer = setTimeout(() => { expiry.delete(id); try { if (step < wait) arm(id); else notify(id, 'expired'); } catch (e) { log('expiry: ' + e.message); } }, step);
  timer.unref();
  expiry.set(id, timer);
}

/** What each computer would be told: its own state and that of the Discord user it is logged in as. */
const snapshot = () => {
  const db = users();
  return new Map(Object.entries(accounts()).map(([id, a]) => {
    const u = userOf(a, db) || {};
    return [id, JSON.stringify([a.revoked, a.hwid, a.user, u.plan, u.expires, u.revoked, u.hwid, u.hwid_reset_at, u.username, u.global_name, u.avatar])];
  }));
};
/** accounts.json or users.json changed (a login, a key, a reset, or the admin commands in another process): every
 *  computer it touched is told - so the old computer hears at once that its account's lock moved away. */
function watchAccounts() {
  fs.mkdirSync(DATA, { recursive: true });
  known = snapshot();
  let timer = null;
  const look = () => {
    try {
      const now = snapshot();
      for (const [id, state] of now) if (known.get(id) !== state) { notify(id, known.has(id) ? 'account-changed' : 'account-created'); arm(id); }
      known = now;
    } catch (e) { log('watch: ' + e.message); }          // a file being rewritten at that moment: the next change looks again
  };
  fs.watch(DATA, (event, name) => { if (name && /^(accounts|users)\.json$/.test(String(name))) { clearTimeout(timer); timer = setTimeout(look, 120); } }).on('error', () => {});
}

/** The client's address as this server counts it. Behind one trusted proxy (GRAPE_TRUST_PROXY=1) it is the LAST entry of
 *  X-Forwarded-For - the one the proxy itself added; the entries before it are whatever the client sent. */
function ipOf(req) {
  if (process.env.GRAPE_TRUST_PROXY === '1') {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || '?';
}

function upgrade(req, sock) {
  // Node hands the socket over without its own error handler: a reset on one that is turned away below (or at any
  // time) would be an unhandled 'error' and end the whole process
  sock.on('error', () => sock.destroy());
  const from = ipOf(req);
  const key = req.headers['sec-websocket-key'];
  // the loader is not a web page: a request that names an Origin came from one
  if (req.url !== '/v1/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || key.length > 40 || req.headers.origin) { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
  if ([...connections].filter((c) => c.from === from).length >= 12) { sock.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  sock.setTimeout(0);
  const conn = { sock, from, chunks: [], have: 0, alive: true, account: null, frag: null, fragSize: 0, fragOp: 0, ready: false, hello: null, rx: 0 };
  connections.add(conn);
  record({ from, method: 'WS', url: 'connected', request: {}, status: 101, response: { open: connections.size }, ms: 0 });
  sock.on('data', (chunk) => { conn.chunks.push(chunk); conn.have += chunk.length; if (conn.have > capOf(conn) + 1024) return closeWith(conn, 1009, 'too big'); parse(conn); });
  const gone = () => {
    if (!connections.delete(conn)) return;
    if (conn.account) byAccount.get(conn.account)?.delete(conn);
    record({ from, method: 'WS', url: 'closed', request: {}, status: 200, response: { open: connections.size }, ms: 0 });
  };
  sock.on('close', gone);
  sock.on('error', () => sock.destroy());
}
setInterval(() => {
  for (const conn of connections) {
    if (!conn.alive) { conn.sock.destroy(); continue; }       // it did not answer the last ping
    conn.alive = false;
    send(conn, 9, Buffer.alloc(0));
  }
}, 20000).unref();


// ------------------------------------------------------------------ the browser's side of a login (the Next.js pages)

/** A login waiting for its browser, or null when it is unknown or too old. */
function loginOf(state) {
  const l = logins.get(String(state || ''));
  return l && Date.now() - l.at <= LOGIN_SECONDS * 1000 ? l : null;
}

/** Only a path on this site: where a login on the website alone goes back to. */
const safeBack = (to) => (typeof to === 'string' && /^\/(?!\/)[\w\-/?=&.%]*$/.test(to) ? to : '/');

/** A login on the website alone (the browser, no computer): its own state. */
function startWebLogin(back, from) {
  sweepLogins();
  if (logins.size > 5000 || tooMany(guesses, 'weblogin:' + (from || '?'), 20, 600)) return null;     // too many from one address, or too many open
  const state = crypto.randomBytes(24).toString('hex');
  logins.set(state, { web: true, at: Date.now(), back: safeBack(back) });
  return state;
}

/** Discord's authorize page for a login, or null when Discord is not set up. */
function authorizeUrl(state) {
  const c = discordConfig();
  if (!c || !loginOf(state)) return null;
  return 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ response_type: 'code', client_id: c.client_id, scope: 'identify', state, redirect_uri: c.redirect_uri });
}

/** Keeps what Discord says about a user (name, picture), making the user if it is new. Writes users.json. */
function rememberUser(discordId, profile) {
  const db = users();
  const user = db[discordId] || (db[discordId] = { plan: null, expires: 0, revoked: false, hwid: null, hwid_set_at: 0, hwid_reset_at: 0, created: Date.now(), uses: 0, redeemed: [] });
  Object.assign(user, { username: profile.username || user.username || '', global_name: profile.global_name || user.global_name || '', avatar: profile.avatar === undefined ? user.avatar || '' : profile.avatar || '' });
  write(USERS, db);
  return user;
}

const nameOf = (user) => (user && (user.global_name || user.username)) || 'Discord user';
const doneUrl = (user, device) => '/link/done?' + new URLSearchParams({ name: nameOf(user), here: hwidOk(user, (accounts()[device] || {}).hwid) ? '1' : '0' });

/** Where Discord sent the browser back: the code is exchanged (with the client secret), and the computer that asked is
 *  logged in as that user - or, for a login on the website alone, only the browser. Answers {problem} or {session, next}. */
async function finishDiscord(query, from) {
  const state = query.get('state') || '';
  const login = loginOf(state);
  logins.delete(state);                                  // a login is used once, whatever happens next
  if (query.get('error')) return { problem: 'cancelled' };
  if (!login) return { problem: 'expired' };
  if (tooMany(failures, from, 30, 60)) return { problem: 'busy' };
  const c = discordConfig();
  if (!c) return { problem: 'unset' };
  let me;
  try {
    const token = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: query.get('code') || '', redirect_uri: c.redirect_uri, client_id: c.client_id, client_secret: c.client_secret }),
    }).then((r) => r.json());
    if (!token.access_token) throw new Error('token: ' + (token.error_description || token.error || 'no access token'));
    me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + token.access_token } }).then((r) => r.json());
    if (!/^\d{5,25}$/.test(String(me.id || ''))) throw new Error('users/@me: no user id');
  } catch (e) {
    log(`discord login failed${login.device ? ' for computer ' + login.device : ''}: ${e.message || e}`);
    return { problem: 'failed' };
  }
  const id = String(me.id);
  const profile = { username: me.username, global_name: me.global_name, avatar: me.avatar };
  const session = signCookie('site', id, 30);
  if (login.web) {
    rememberUser(id, profile);
    log(`website: ${id} (${me.username}) logged in`);
    return { session, next: login.back };
  }
  link(login.device, id, profile);
  return { session, next: doneUrl(users()[id], login.device) };
}

/** What the "Continue with website" page shows: the account this browser is logged in with, and the code of the login. */
function linkPage(state, cookie) {
  const login = loginOf(state);
  if (!login || login.web) return { problem: 'expired' };
  const who = readCookie('site', cookie);
  const user = who && users()[who];
  if (!user) return { login: true };
  return { name: nameOf(user), username: user.username || '', avatar: avatarOf(who, user), code: login.code };
}

/** "Continue" on that page: this computer is logged in as the browser's account. Answers {problem} or {next}. */
function confirmLink(state, cookie) {
  const login = loginOf(state);
  if (!login || login.web) return { problem: 'expired' };
  const who = readCookie('site', cookie);
  if (!who || !users()[who]) return { next: '/login/discord?state=' + encodeURIComponent(state) };
  logins.delete(state);
  link(login.device, who, {});
  return { next: doneUrl(users()[who], login.device) };
}

/** The website's own account (the browser's cookie): who it is, or null. */
function siteUser(cookie) {
  const who = readCookie('site', cookie);
  const user = who && users()[who];
  if (!user) return null;
  return { id: who, name: nameOf(user), username: user.username || '', avatar: avatarOf(who, user), plan_name: planName(user.plan), active: active(user), expires: user.expires };
}

// ------------------------------------------------------------------ signed cookies (the website, the admin page)

const SESSION_KEY = path.join(DATA, 'session.key');
let sessionKeyCache = null;
function sessionKey() {
  if (sessionKeyCache) return sessionKeyCache;
  try { sessionKeyCache = fs.readFileSync(SESSION_KEY); } catch { /* made below */ }
  if (!sessionKeyCache || sessionKeyCache.length !== 32) {
    sessionKeyCache = crypto.randomBytes(32);
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SESSION_KEY, sessionKeyCache, { mode: 0o600 });
  }
  return sessionKeyCache;
}
const b64url = (b) => Buffer.from(b).toString('base64url');

/** kind | value | expiry, signed with this server's session key. */
function signCookie(kind, value, days) {
  const body = b64url(JSON.stringify({ k: kind, v: value, e: Date.now() + days * DAY }));
  return body + '.' + b64url(hmac(sessionKey(), 'grape-cookie-v1', body));
}
function readCookie(kind, text) {
  const [body, sig] = String(text || '').split('.');
  if (!body || !sig) return null;
  const want = hmac(sessionKey(), 'grape-cookie-v1', body);
  const got = Buffer.from(sig, 'base64url');
  if (!same(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return c.k === kind && c.e > Date.now() ? c.v : null;
  } catch { return null; }
}
const COOKIES = { site: 'grape_site', admin: 'grape_admin' };

// ------------------------------------------------------------------ the admin password

const ADMIN = path.join(DATA, 'admin.json');
let setupToken = null;
const adminReady = () => !!read(ADMIN).hash;
/** The one-time link that sets the first password, printed when the server starts (works behind a proxy too). */
function setupLink() {
  if (adminReady()) return null;
  if (!setupToken) setupToken = crypto.randomBytes(16).toString('hex');
  return `${publicUrl()}/admin-grape?setup=${setupToken}`;
}
function setAdminPassword(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters.';
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  write(ADMIN, { salt: salt.toString('hex'), hash: hash.toString('hex'), at: Date.now() });
  setupToken = null;
  log('admin: the admin password was set');
  return '';
}
function adminPasswordOk(password) {
  const a = read(ADMIN);
  if (!a.hash || typeof password !== 'string') return false;
  return same(crypto.scryptSync(password, Buffer.from(a.salt, 'hex'), 64), Buffer.from(a.hash, 'hex'));
}
/** An admin cookie is good while the password it was made under is: a new password signs everyone out. */
const adminStamp = () => (read(ADMIN).hash || '').slice(0, 16);
const isAdmin = (cookie) => adminReady() && readCookie('admin', cookie) === adminStamp();

// ------------------------------------------------------------------ what the admin does (the admin page, the commands)

const shortHwid = (h) => (h ? h.slice(0, 10) + '...' : '');
const startedAt = Date.now();

const installer = require('./installer')({ DATA, read, write, log, publicUrl, tooMany, alert });

/** How many installers one person may make in a day (Settings > Website; 0 = no limit), and when the admin last reset the count. */
function installerLimits() {
  const s = read(SETTINGS);
  const limit = Number.isInteger(s.installer_daily_limit) && s.installer_daily_limit >= 0 && s.installer_daily_limit <= 1000 ? s.installer_daily_limit : 3;
  return { limit, since: Number(s.installer_limit_reset) || 0 };
}

/** A key redeemed on the website (the download popup): the same rules as in Grape, for the Discord user who is logged in here.
 *  {status, body}, and the body is the new state when it worked. */
function siteRedeem(cookie, code, from) {
  const who = siteUser(cookie);
  if (!who) return { status: 401, body: { error: 'Log in with Discord first.', login: true } };
  if (tooMany(guesses, 'site:' + who.id, 8, 60)) { alert('guess', `${who.id} is trying many keys on the website.`); return { status: 429, body: { error: 'Too many keys tried. Wait a minute.' } }; }
  const db = users();
  const user = own(db, who.id);
  if (!user) return { status: 404, body: { error: 'That account was not found. Log in again.' } };
  if (user.revoked) return { status: 403, body: { error: 'This account has been switched off.' } };
  const normal = normalise(code);
  const all = keys();
  const key = normal.length === 25 && normal.startsWith('GRAPE') ? all[keyHash(normal)] : null;
  if (!key || key.revoked) { log(`redeem-key: ${who.id} tried a key that does not exist (website)`); return { status: 403, body: { error: 'That key is not valid.' } }; }
  if (key.used_by) { log(`redeem-key: ${who.id} tried a key that was used (website)`); return { status: 403, body: { error: 'That key has already been used.' } }; }
  const problem = addPlan(user, key.plan);
  if (problem) return { status: 409, body: { error: problem } };
  key.used_by = who.id;
  key.used_by_computer = null;
  key.used_at = Date.now();
  write(KEYS, all);
  try {
    write(USERS, db);
  } catch (e) {                                          // the user got no time: the key is not used up
    key.used_by = null; key.used_at = null;
    try { write(KEYS, all); } catch { /* the log below says it */ }
    log(`redeem-key: could not save the time for ${who.id}, the key was given back (${e.message})`);
    return { status: 500, body: { error: 'The key could not be redeemed, and was not used up. Try again.' } };
  }
  log(`redeem-key: ${who.id} redeemed a ${key.plan} key on the website, now until ${user.expires === null ? 'forever' : new Date(user.expires).toISOString()}`);
  return siteInstaller(cookie, 'state', from);
}

/** What the download popup on the website asks: who is logged in and what they may do ('state'), or an installer for them
 *  ('make'). {status, body}; `cookie` is the website's login cookie, `from` the visitor's address. */
function siteInstaller(cookie, action, from) {
  const who = siteUser(cookie);
  const s = site();
  const have = installer.status();
  const ready = !!(s.download_url || (have.stub && have.app));
  const record = who ? own(users(), who.id) : null;
  const base = {
    ready, external: s.download_url || '', version: have.version, size: have.app_size,
    user: who ? { name: who.name, avatar: who.avatar, active: who.active, plan_name: who.plan_name, expires: who.expires, revoked: !!(record && record.revoked) } : null,
  };
  const limits = installerLimits();
  if (action === 'state') return { status: 200, body: { ...base, quota: who ? installer.quota(who.id, limits) : null } };
  if (action !== 'make') return { status: 400, body: { error: 'Bad request.' } };
  if (!who) return { status: 401, body: { ...base, error: 'Log in with Discord first.', login: true } };
  // only an account with time on it gets an installer (a key is redeemed in the popup, or in Grape)
  if (!who.active) return { status: 403, body: { ...base, needs_time: true, error: base.user.revoked ? 'This account has been switched off.' : 'You need time on your account to download Grape. Redeem a key first.' } };
  if (!ready) return { status: 503, body: { ...base, error: 'The installer is not ready yet. Try again in a little while.' } };
  if (s.download_url) return { status: 200, body: { ...base, url: s.download_url } };
  if (tooMany(webhits, 'make:' + from, 12, 600)) return { status: 429, body: { ...base, error: 'Too many tries from here. Wait a few minutes.' } };
  try {
    const made = installer.issueFor(who.id, who.name, limits);
    log(`installer: website download for ${who.id} from ${from}`);
    return { status: 200, body: { ...base, url: '/get/' + made.token, quota: installer.quota(who.id, limits) } };
  } catch (e) {
    return { status: 429, body: { ...base, error: e.message, limit: !!e.limit, quota: installer.quota(who.id, limits) } };
  }
}

const ops = {
  installers: () => installer.list(),
  makeInstaller: (note, hours) => installer.make({ note, hours, by: 'admin' }),
  revokeInstaller: (id) => installer.revoke(id),
  installerStatus: () => installer.status(),
  installerSettings: () => ({ ...installerLimits() }),
  saveInstallerLimit(limit) {
    const n = parseInt(limit, 10);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error('The limit must be a number from 0 (no limit) to 1000.');
    const s = read(SETTINGS);
    s.installer_daily_limit = n;
    write(SETTINGS, s);
    log(`admin: installers per person per day set to ${n === 0 ? 'no limit' : n}`);
    return ops.installerSettings();
  },
  /** Everyone's count of installers made today goes back to nothing (the installers themselves stay in the list). */
  resetInstallerLimits() {
    const s = read(SETTINGS);
    s.installer_limit_reset = Date.now();
    write(SETTINGS, s);
    log('admin: the installer counts of today were reset');
    return ops.installerSettings();
  },

  /** The safety settings of the admin page. The webhook address is a secret: only "set" is ever said. */
  security() {
    const s = read(SETTINGS), st = installer.status();
    return {
      min_version: s.min_version || '', require_build: s.require_build === true, alert_webhook: s.alert_webhook ? 'set' : '', admin_ips: String(s.admin_ips || ''),
      from_env: { admin_ips: !!process.env.GRAPE_ADMIN_IPS, alert_webhook: !!process.env.GRAPE_ALERT_WEBHOOK }, app_sha256: st.app_sha256, version: st.version,
    };
  },
  saveSecurity(body, ip) {
    const s = read(SETTINGS);
    const min = String(body.min_version || '').trim();
    if (min && !VERSION.test(min)) throw new Error('The oldest version must look like 0.2.0.');
    const hook = String(body.alert_webhook || '').trim();
    if (hook && hook !== 'set' && !WEBHOOK.test(hook)) throw new Error('The alert address must be a Discord webhook: https://discord.com/api/webhooks/...');
    const ips = String(body.admin_ips || '').split(/[\s,;]+/).map(cleanIp).filter(Boolean);
    for (const i of ips) if (!net.isIP(i)) throw new Error(`"${i.slice(0, 40)}" is not an IP address.`);
    if (!process.env.GRAPE_ADMIN_IPS && ips.length && !ips.includes(cleanIp(ip))) throw new Error(`Your own address (${cleanIp(ip)}) must be in the list, or this page would shut you out.`);
    if (min) s.min_version = min; else delete s.min_version;
    if (body.require_build === true) s.require_build = true; else delete s.require_build;
    if (hook !== 'set') { if (hook) s.alert_webhook = hook; else delete s.alert_webhook; }
    if (!process.env.GRAPE_ADMIN_IPS) { if (ips.length) s.admin_ips = ips.join(', '); else delete s.admin_ips; }
    write(SETTINGS, s);
    log('admin: security settings saved');
    return ops.security();
  },

  plans: () => Object.entries(PLANS).map(([id, p]) => ({ id, name: p.name, days: p.days })),

  makeKeys(plan, count, note) {
    if (!own(PLANS, plan)) throw new Error('That plan does not exist.');
    count = Math.min(500, Math.max(1, parseInt(count, 10) || 1));
    note = String(note || '').slice(0, 80);
    const db = keys();
    const made = [];
    for (let i = 0; i < count; i++) {
      let body = 'GRAPE';
      while (body.length < 25) body += ALPHABET[crypto.randomInt(ALPHABET.length)];
      db[keyHash(body)] = { plan, note, created: Date.now(), used_by: null, used_at: null, revoked: false };
      made.push(body.match(/.{5}/g).join('-'));
    }
    write(KEYS, db);
    log(`keys: made ${count} ${plan} key${count === 1 ? '' : 's'}${note ? ' (' + note + ')' : ''}`);
    return made;
  },

  keys() {
    const db = users();
    return Object.entries(keys()).map(([hash, k]) => ({
      hash, plan: k.plan, plan_name: planName(k.plan), note: k.note || '', created: k.created || 0,
      used_by: k.used_by || null, used_by_name: k.used_by ? nameOf(db[k.used_by]) : '', used_at: k.used_at || 0, revoked: !!k.revoked,
    })).sort((a, b) => b.created - a.created);
  },

  cancelKey(hash) {
    const db = keys();
    const hit = Object.keys(db).filter((h) => h.startsWith(String(hash || '#')));
    if (hit.length !== 1) throw new Error(hit.length ? 'More than one key starts like that.' : 'No such key.');
    if (db[hit[0]].used_by) throw new Error('That key was already used.');
    db[hit[0]].revoked = true;
    write(KEYS, db);
    log(`keys: cancelled ${hit[0].slice(0, 8)}`);
  },

  users() {
    const devices = accounts();
    return Object.entries(users()).map(([id, u]) => ({
      id, name: nameOf(u), username: u.username || '', avatar: avatarOf(id, u),
      plan: u.plan || null, plan_name: planName(u.plan), expires: u.expires, active: active(u), revoked: !!u.revoked,
      hwid: shortHwid(u.hwid), hwid_set_at: u.hwid_set_at || 0, hwid_reset_at: u.hwid_reset_at || 0,
      computers: Object.entries(devices).filter(([, d]) => d.user === id).map(([cid]) => cid),
      uses: u.uses || 0, last: u.last || 0, created: u.created || 0,
    })).sort((a, b) => (b.last || b.created) - (a.last || a.created));
  },

  /** A Discord user, by its id or by the id of a computer logged in as it. */
  userId(id) {
    const db = users(), devices = accounts();
    if (own(db, id)) return id;
    const device = own(devices, id);
    if (device && device.user && own(db, device.user)) return device.user;
    throw new Error(device ? 'That computer is not logged in with Discord.' : 'No Discord user or computer with that id.');
  },

  user(id, op, value) {
    id = ops.userId(id);
    const db = users();
    const u = db[id];
    if (op === 'grant') {
      const problem = addPlan(u, value);
      if (problem) throw new Error(problem);
    } else if (op === 'extend') {
      const days = Number(value);
      if (!Number.isFinite(days) || days === 0) throw new Error('How many days?');
      if (u.expires === null) throw new Error('That user has a lifetime license.');
      u.expires = (u.expires > Date.now() ? u.expires : Date.now()) + days * DAY;
      u.plan = u.plan || 'month';
    } else if (op === 'revoke' || op === 'unrevoke') {
      u.revoked = op === 'revoke';
    } else if (op === 'reset-hwid') {
      u.hwid = null;                                     // the next computer of this user that asks takes the lock
    } else if (op === 'clear-plan') {
      Object.assign(u, { plan: null, expires: 0 });
    } else {
      throw new Error('Unknown action.');
    }
    write(USERS, db);
    log(`admin: ${op}${value !== undefined ? ' ' + value : ''} for ${id} (${u.username || ''})`);
    return u;
  },

  computers() {
    const db = users();
    return Object.entries(accounts()).map(([id, d]) => ({
      id, hwid: shortHwid(d.hwid), user: d.user || null, user_name: d.user ? nameOf(db[d.user]) : '', created: d.created || 0,
      online: (byAccount.get(id) || new Set()).size > 0, revoked: !!d.revoked, old_plan: d.plan || null,
    })).sort((a, b) => (b.online - a.online) || (b.created - a.created));
  },

  link(computer, discordId, name) {
    if (!accounts()[computer]) throw new Error('No computer with that id.');
    if (!/^\d{1,25}$/.test(String(discordId || ''))) throw new Error('A Discord user id is a number.');
    link(computer, String(discordId), { username: name || undefined });
  },

  unlink(computer) {
    const db = accounts();
    if (!db[computer]) throw new Error('No computer with that id.');
    delete db[computer].user;
    write(ACCOUNTS, db);
    log(`admin: logged computer ${computer} out`);
  },

  discord() {
    const file = read(DISCORD);
    return {
      client_id: process.env.GRAPE_DISCORD_CLIENT_ID || file.client_id || '',
      has_secret: !!(process.env.GRAPE_DISCORD_CLIENT_SECRET || file.client_secret),
      redirect_uri: process.env.GRAPE_DISCORD_REDIRECT_URI || file.redirect_uri || '',
      default_redirect: `${publicUrl()}/v1/discord/callback`,
      public_url: publicUrl(),
      saved_public_url: read(SETTINGS).public_url || '',          // what is in the file, apart from what the environment says
      from_env: { client_id: !!process.env.GRAPE_DISCORD_CLIENT_ID, client_secret: !!process.env.GRAPE_DISCORD_CLIENT_SECRET, redirect_uri: !!process.env.GRAPE_DISCORD_REDIRECT_URI, public_url: !!process.env.GRAPE_PUBLIC_URL },
      ready: !!discordConfig(),
    };
  },

  /** Saves the Discord application. An empty secret keeps the one that is saved. */
  saveDiscord({ client_id, client_secret, redirect_uri, public_url }) {
    const id = String(client_id || '').trim();
    if (id && !/^\d{5,25}$/.test(id)) throw new Error('The Client ID is a number (OAuth2 > Client ID).');
    const redirect = String(redirect_uri || '').trim();
    if (redirect && !/^https?:\/\/[^\s]+\/v1\/discord\/callback$/.test(redirect)) throw new Error('The redirect must end in /v1/discord/callback.');
    const pub = String(public_url || '').trim().replace(/\/+$/, '');
    if (pub && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(pub)) throw new Error('The public URL is like https://grape.example.com (no path).');
    const file = read(DISCORD);
    // what the server's environment sets is not copied into the file (the page shows those fields locked)
    const next = {
      client_id: process.env.GRAPE_DISCORD_CLIENT_ID ? file.client_id || '' : id,
      client_secret: process.env.GRAPE_DISCORD_CLIENT_SECRET ? file.client_secret || '' : String(client_secret || '').trim() || file.client_secret || '',
      redirect_uri: process.env.GRAPE_DISCORD_REDIRECT_URI ? file.redirect_uri || '' : redirect,
    };
    write(DISCORD, next);
    try { fs.chmodSync(DISCORD, 0o600); } catch { /* Windows */ }
    const settings = read(SETTINGS);
    if (!process.env.GRAPE_PUBLIC_URL) { if (pub) settings.public_url = pub; else delete settings.public_url; }
    write(SETTINGS, settings);
    log('admin: Discord settings saved');
    return ops.discord();
  },

  overview() {
    const u = users(), k = Object.values(keys()), d = accounts();
    let logTail = [];
    try { logTail = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-40).reverse(); } catch { /* no log yet */ }
    return {
      users: Object.keys(u).length, active: Object.values(u).filter(active).length, computers: Object.keys(d).length,
      online: [...byAccount.values()].filter((s) => s.size > 0).length, connections: connections.size,
      keys_unused: k.filter((x) => !x.used_by && !x.revoked).length, keys_used: k.filter((x) => x.used_by).length,
      installer: installer.status(), discord: !!discordConfig(), payload: hasPayload(), resource_key: fs.existsSync(RESOURCE_KEY_FILE), ui_bundle: fs.existsSync(UI_BUNDLE),
      public_url: publicUrl(), data: DATA, started: startedAt, now: Date.now(), dev: DEV, log: logTail,
    };
  },
};

/** One call of the admin page: {status, body, cookie?}. Everything but the password itself needs the admin cookie. */
async function adminApi(action, body, { ip, cookie }) {
  const ok = (b, extra) => ({ status: 200, body: b, ...extra });
  const no = (status, error) => ({ status, body: { error } });
  body = body && typeof body === 'object' ? body : {};
  if (!adminAllowed(ip)) return no(404, 'Not found.');
  if (action === 'state') return ok({ ready: adminReady(), authed: isAdmin(cookie) });
  if (action === 'setup') {
    if (adminReady()) return no(409, 'The admin password is already set.');
    if (!setupToken || typeof body.token !== 'string' || !same(Buffer.from(body.token), Buffer.from(setupToken))) return no(403, 'This setup link is not valid. Use the one the server printed when it started.');
    const problem = setAdminPassword(body.password);
    if (problem) return no(400, problem);
    return ok({ authed: true }, { cookie: signCookie('admin', adminStamp(), 0.5) });
  }
  if (action === 'login') {
    // only wrong passwords count, and only against the address they came from: a right password is never held up, and
    // a stranger cannot lock the real admin out by sending wrong ones from elsewhere
    if (blocked(failures, 'admin:' + ip, 10, 600)) return no(429, 'Too many tries from here. Wait ten minutes.');
    if (!adminPasswordOk(body.password)) { tooMany(failures, 'admin:' + ip, 10, 600); log(`admin: wrong password from ${ip}`); alert('admin-failed', `A wrong admin password was tried from ${ip}.`); return no(403, 'That is not the admin password.'); }
    log(`admin: signed in from ${ip}`);
    alert('admin-in', `The admin page was signed in to from ${ip}.`);
    return ok({ authed: true }, { cookie: signCookie('admin', adminStamp(), 0.5) });
  }
  if (action === 'logout') return ok({ authed: false }, { cookie: '' });
  if (!isAdmin(cookie)) return no(401, 'Sign in again.');
  try {
    switch (action) {
      case 'overview': return ok(ops.overview());
      case 'plans': return ok(ops.plans());
      case 'keys': return ok(ops.keys());
      case 'make-keys': return ok({ keys: ops.makeKeys(body.plan, body.count, body.note) });
      case 'cancel-key': ops.cancelKey(body.hash); return ok({ done: true });
      case 'users': return ok(ops.users());
      case 'user': ops.user(String(body.id || ''), body.op, body.value); return ok({ done: true });
      case 'computers': return ok(ops.computers());
      case 'unlink': ops.unlink(String(body.id || '')); return ok({ done: true });
      case 'discord': return ok(ops.discord());
      case 'save-discord': return ok(ops.saveDiscord(body));
      case 'site': return ok(site());
      case 'save-site': return ok(saveSite(body));
      case 'security': return ok(ops.security());
      case 'save-security': return ok(ops.saveSecurity(body, ip));
      case 'installers': return ok({ list: ops.installers(), ...ops.installerStatus() });
      case 'installer-settings': return ok(ops.installerSettings());
      case 'save-installer-limit': return ok(ops.saveInstallerLimit(body.limit));
      case 'reset-installer-limits': return ok(ops.resetInstallerLimits());
      case 'make-installer': return ok(ops.makeInstaller(body.note, body.hours));
      case 'revoke-installer': ops.revokeInstaller(String(body.id || '')); return ok({ done: true });
      case 'password': {
        if (!adminPasswordOk(body.current)) return no(403, 'The current password is not right.');
        const problem = setAdminPassword(body.password);
        if (problem) return no(400, problem);
        return ok({ done: true }, { cookie: signCookie('admin', adminStamp(), 0.5) });
      }
      default: return no(404, 'Unknown action.');
    }
  } catch (e) {
    return no(400, e.message || String(e));
  }
}

// ------------------------------------------------------------------ the HTTP this server answers itself

/** The cookies of a request, by name. */
function cookiesOf(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
/** A cookie for the browser: HttpOnly, this site only, Secure once the site is https. An empty value removes it. */
function cookieHeader(name, value, days) {
  const secure = publicUrl().startsWith('https://') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value || '')}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${value ? Math.round(days * 86400) : 0}`;
}
/** A request sent from this site's own page (not from another site's page posting into it). `get(name)` reads a header of
 *  the request, `host` is the Host it came to.
 *  A browser sends Origin with a POST, and then it is the address of this site. But every page of this site says
 *  Referrer-Policy: no-referrer, and a form posted from such a page carries "Origin: null": then Sec-Fetch-Site, which
 *  every current browser sends and a page cannot change, says whether it came from this very site. */
function sameSite(get, host) {
  const origin = get('origin');
  if (origin && origin !== 'null') {
    try { return new URL(origin).host === host || origin === publicUrl(); } catch { return false; }
  }
  const fetchSite = get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin';
  return !origin;                                    // no Origin and no Sec-Fetch-Site: a tool, not a page
}
const sameOrigin = (req) => sameSite((name) => req.headers[name], req.headers.host);
function redirect(res, to, cookies) {
  const headers = { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (cookies && cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(to.startsWith('/') ? 303 : 302, headers);
  res.end();
}
const problemUrl = (why) => '/login/problem?why=' + encodeURIComponent(why);
async function readForm(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 4096) break; }
  return new URLSearchParams(text);
}

/** What the custom server answers before Next.js: the health check, the development viewer, and the login steps that
 *  are only redirects (to Discord, back from it, "Continue", log out). The pages around them are Next.js. */
async function http(req, res) {
  const url = new URL(req.url, 'http://x');
  const reply = (code, body) => {
    const text = JSON.stringify(typeof body === 'string' ? { error: body } : body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const from = req.headers['x-grape-ip'] || ipOf(req);
  if (DEV && req.url.startsWith('/view-process')) { viewer(req, res, reply); return true; }
  if ((url.pathname.startsWith('/admin-grape') || url.pathname.startsWith('/api/admin')) && !adminAllowed(from)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found.');
    return true;
  }
  // the pages a stranger can start something from: one address may ask for only so many
  if (/^\/(login|link|download|get)(\/|$)|^\/v1\/(discord|install)\//.test(url.pathname) && tooMany(webhits, 'web:' + from, 120, 60)) {
    alert('ratelimit', `${from} is asking the login and download pages too often.`);
    reply(429, 'Too many requests. Wait a minute.');
    return true;
  }
  if (await installer.route(req, res, url, from)) return true;
  if (req.method === 'GET' && url.pathname === '/v1/health') { reply(200, { ok: true, payload: hasPayload(), discord: !!discordConfig(), time: Date.now() }); return true; }

  // to Discord. The website's own login (?back=/where) goes straight there. A computer's login (?state from the app)
  // first shows its code (/login/confirm): a link made on one computer and sent to someone else would otherwise log
  // that computer in as whoever approves it on Discord.
  if (req.method === 'GET' && url.pathname === '/login/discord') {
    if (!discordConfig()) { redirect(res, problemUrl('unset')); return true; }
    const asked = url.searchParams.get('state');
    if (asked) {
      const login = loginOf(asked);
      redirect(res, !login ? problemUrl('expired') : login.web ? (authorizeUrl(asked) || problemUrl('expired')) : '/login/confirm?state=' + encodeURIComponent(asked));
      return true;
    }
    const web = startWebLogin(url.searchParams.get('back'), from);
    redirect(res, (web && authorizeUrl(web)) || problemUrl(web ? 'expired' : 'busy'));
    return true;
  }
  // "Continue with Discord" on the code page
  if (req.method === 'POST' && url.pathname === '/login/discord/go') {
    if (!sameOrigin(req)) { reply(403, 'Not from this site.'); return true; }
    const state = (await readForm(req)).get('state') || '';
    redirect(res, (loginOf(state) && authorizeUrl(state)) || problemUrl('expired'));
    return true;
  }
  // back from Discord
  if (req.method === 'GET' && url.pathname === '/v1/discord/callback') {
    const done = await finishDiscord(url.searchParams, from);
    if (done.problem) { redirect(res, problemUrl(done.problem)); return true; }
    redirect(res, done.next, [cookieHeader(COOKIES.site, done.session, 30)]);
    return true;
  }
  // "Continue" on the "Continue with website" page
  if (req.method === 'POST' && url.pathname === '/link/confirm') {
    if (!sameOrigin(req)) { reply(403, 'Not from this site.'); return true; }
    const form = await readForm(req);
    const done = confirmLink(form.get('state'), cookiesOf(req)[COOKIES.site]);
    redirect(res, done.problem ? problemUrl(done.problem) : done.next);
    return true;
  }
  if (url.pathname === '/logout') {
    redirect(res, '/', [cookieHeader(COOKIES.site, '', 0)]);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/download') {
    // the download popup on the download page does the rest (it asks /api/installer); an old link opens it
    redirect(res, '/install?download=1');
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ the website's own settings (the admin page)

const SITE = path.join(DATA, 'site.json');
/** What the landing page shows that is not in the code: links, and a price per plan (empty = not shown). */
function site() {
  const s = read(SITE);
  const have = installer.status();
  return { discord_url: s.discord_url || '', download_url: s.download_url || '', download_ready: !!s.download_url || (have.stub && have.app), prices: s.prices && typeof s.prices === 'object' ? s.prices : DEFAULT_PRICES };
}
function saveSite(body) {
  const link = (v, what) => {
    const t = String(v || '').trim();
    if (t && !/^https:\/\/[^\s]+$/.test(t)) throw new Error(`The ${what} must be an https:// address.`);
    return t;
  };
  const prices = {};
  for (const id of Object.keys(PLANS)) {
    const p = String((body.prices || {})[id] || '').trim().slice(0, 24);
    if (p) prices[id] = p;
  }
  write(SITE, { discord_url: link(body.discord_url, 'Discord invite'), download_url: link(body.download_url, 'download link'), prices });
  log('admin: website settings saved');
  return site();
}

function start() {
  fs.mkdirSync(DATA, { recursive: true });
  watchAccounts();
}

module.exports = {
  PORT, BIND, DATA, DEV, PLANS, COOKIES,
  start, upgrade, http, log, publicUrl, discordConfig,
  loginOf, startWebLogin, authorizeUrl, finishDiscord, linkPage, confirmLink, siteUser, signCookie, readCookie,
  ipOf, setupLink, adminApi, ops, site, users: () => users(), sha256, hmac, seal, open, idOf,
  setAdminPasswordFromCli: setAdminPassword, refuseBuild, olderThan, installer, siteInstaller, siteRedeem, installerLimits, sameSite, SECURE, active: (u) => active(u),
};
