// The installer the server gives out, and the rule that it works ONCE.
//
//   An installer is a small program (payload/grape-setup.exe) that this server completes with a trailer holding the
//   server's address and a token made for that one download:  [setup.exe][{"v":1,"server","token"}][u32 length][GRPSETUP]
//   The token is kept here only as a hash. What the installer does with it:
//
//     GET  /get/<token>                  the installer (while it has not been started, and has not run out)
//     POST /v1/install/check {token, hwid}  -> {version, size}: is it still good? (uses nothing up)
//     POST /v1/install/claim {token, hwid}  -> {ticket, size, sha256, version}: this computer takes the installer. From
//                                           now on it is this computer's alone; another one is turned away
//     GET  /v1/install/file/<ticket>     Grape itself (payload/Grape.exe), once per ticket, 20 minutes
//     POST /v1/install/done {token, hwid}   the program is on the computer: the installer is USED, for good
//
//   issued -> claimed (one computer, may try again if it was interrupted) -> used. Used, cancelled and run-out installers
//   answer nothing but "no".
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOUR = 3600 * 1000;
const TICKET_MS = 20 * 60 * 1000;
const MAX_CLAIMS = 6;                      // how often one installer may start over (a dropped connection)
const MAGIC = Buffer.from('GRPSETUP');

module.exports = function installers(c) {
  const { DATA, read, write, log, publicUrl, tooMany, alert } = c;
  const FILE = path.join(DATA, 'installers.json');
  const STUB = process.env.GRAPE_SETUP_STUB || path.join(__dirname, '..', 'payload', 'grape-setup.exe');
  const APP = process.env.GRAPE_APP_EXE || path.join(__dirname, '..', 'payload', 'Grape.exe');
  const VERSION = process.env.GRAPE_APP_VERSION_FILE || path.join(__dirname, '..', 'payload', 'version.json');
  const tries = new Map();

  const hashOf = (token) => crypto.createHash('sha256').update('grape-installer-v1').update(String(token)).digest('hex');
  const ticketHash = (ticket) => crypto.createHash('sha256').update('grape-install-ticket-v1').update(String(ticket)).digest('hex');
  const tokenOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(t);
  const hwidOk = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

  /** Grape as the server hands it out: the bytes and their hash, read again when the file changes. */
  let cached = null;
  function app() {
    let st;
    try { st = fs.statSync(APP); } catch { return null; }
    if (!st.isFile() || st.size < 1024) return null;
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached;
    const bytes = fs.readFileSync(APP);
    let version = '';
    try { version = String(JSON.parse(fs.readFileSync(VERSION, 'utf8')).version || '').slice(0, 20); } catch { /* none said */ }
    cached = { bytes, size: bytes.length, mtime: st.mtimeMs, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), version };
    return cached;
  }

  const stateOf = (r) => (r.revoked ? 'revoked' : r.used_at ? 'used' : r.claim ? 'claimed' : r.expires < Date.now() ? 'expired' : 'issued');

  /** A new installer: its token is returned here and never kept. */
  function make({ note, hours, by }) {
    const db = read(FILE);
    const token = crypto.randomBytes(24).toString('base64url');
    const hash = hashOf(token);
    const id = hash.slice(0, 12);
    const span = Math.min(24 * 30, Math.max(1, parseInt(hours, 10) || 72)) * HOUR;
    db[id] = { hash, note: String(note || '').slice(0, 80), by: by || 'admin', made: Date.now(), expires: Date.now() + span, claim: null, ticket: null, delivered: false, used_at: 0, revoked: false, downloads: 0 };
    write(FILE, db);
    log(`installer: made ${id}${db[id].note ? ' (' + db[id].note + ')' : ''} by ${db[id].by}, good for ${Math.round(span / HOUR)} h`);
    return { id, token, url: `${publicUrl()}/get/${token}`, expires: db[id].expires };
  }

  function list() {
    const db = read(FILE);
    return Object.entries(db).map(([id, r]) => ({
      id, note: r.note || '', by: r.by || 'admin', made: r.made || 0, expires: r.expires || 0, state: stateOf(r),
      downloads: r.downloads || 0, claimed_at: r.claim ? r.claim.at : 0, computer: r.claim ? r.claim.hwid.slice(0, 10) + '...' : '', tries: r.claim ? r.claim.count : 0, used_at: r.used_at || 0,
    })).sort((a, b) => b.made - a.made);
  }

  function revoke(id) {
    const db = read(FILE);
    const r = Object.hasOwn(db, String(id)) ? db[id] : null;
    if (!r) throw new Error('No such installer.');
    if (r.used_at) throw new Error('That installer was already used.');
    r.revoked = true;
    write(FILE, db);
    log(`installer: ${id} cancelled`);
  }

  /** How many installers a Discord user made in the last 24 hours (only those after `since`, the admin's last reset), and
   *  what the limit is: { used, limit, left }. A limit of 0 is no limit. */
  function quota(discordId, { limit = 3, since = 0 } = {}) {
    const from = Math.max(Date.now() - 24 * HOUR, since || 0);
    const used = Object.values(read(FILE)).filter((r) => r.by === discordId && r.made >= from).length;
    return { used, limit, left: limit > 0 ? Math.max(0, limit - used) : null };
  }

  /** One for a Discord user from the website: older ones of theirs that were not started are cancelled, and only so many a day. */
  function issueFor(discordId, name, opts = {}) {
    const q = quota(discordId, opts);
    if (q.limit > 0 && q.used >= q.limit) {
      const e = new Error(`You have made ${q.used} installers in the last 24 hours, which is the most for one day. Use one you already have, or try again tomorrow.`);
      e.limit = true;
      throw e;
    }
    const db = read(FILE);
    for (const r of Object.values(db)) if (r.by === discordId && stateOf(r) === 'issued') r.revoked = true;
    write(FILE, db);
    return make({ note: String(name || '').slice(0, 60), hours: 24, by: discordId });
  }

  const find = (token) => {
    const db = read(FILE);
    const hash = hashOf(token);
    const id = Object.keys(db).find((k) => db[k].hash === hash);
    return id ? { db, id, r: db[id] } : null;
  };

  function status() {
    const a = app();
    let stub = false;
    try { stub = fs.statSync(STUB).size > 1024; } catch { /* none */ }
    return { stub, app: !!a, app_size: a ? a.size : 0, app_sha256: a ? a.sha256 : '', version: a ? a.version : '' };
  }

  const text = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) }); res.end(body); };
  const json = (res, code, body) => {
    const t = JSON.stringify(typeof body === 'string' ? { error: body } : body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(t) });
    res.end(t);
  };
  async function body(req) {
    let t = '';
    for await (const chunk of req) { t += chunk; if (t.length > 2048) return {}; }
    try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  /** Why an installer cannot be used now, as the person who holds it should read it; '' when it can. */
  function refusal(r, hwid) {
    if (r.revoked) return 'This installer was cancelled.';
    if (r.used_at) return 'This installer was already used. Each one works once; ask for a new one.';
    if (r.claim && hwid && r.claim.hwid !== hwid) return 'This installer is already in use on another computer.';
    if (!r.claim && r.expires < Date.now()) return 'This installer has expired. Ask for a new one.';
    return '';
  }

  /** The routes above. True when the request was this module's. */
  async function route(req, res, url, from) {
    const p = url.pathname;
    if (req.method === 'GET' && p.startsWith('/get/')) {
      if (tooMany(tries, 'get:' + from, 30, 600)) { text(res, 429, 'Too many tries. Wait a few minutes.'); return true; }
      const token = p.slice(5);
      const hit = tokenOk(token) ? find(token) : null;
      if (!hit) { text(res, 404, 'This installer link is not valid.'); return true; }
      const why = refusal(hit.r, '') || (hit.r.claim ? 'This installer was already started. Run the program you downloaded.' : '');
      if (why) { text(res, 410, why); return true; }
      let stub;
      try { stub = fs.readFileSync(STUB); } catch { log('installer: payload/grape-setup.exe is missing'); text(res, 503, 'The server has no installer to send yet.'); return true; }
      const trailer = Buffer.from(JSON.stringify({ v: 1, server: publicUrl(), token }));
      const size = Buffer.alloc(4);
      size.writeUInt32LE(trailer.length);
      const file = Buffer.concat([stub, trailer, size, MAGIC]);
      hit.r.downloads = (hit.r.downloads || 0) + 1;
      write(FILE, hit.db);
      log(`installer: ${hit.id} downloaded by ${from}`);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.microsoft.portable-executable', 'Content-Disposition': 'attachment; filename="Grape-Setup.exe"',
        'Content-Length': file.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      res.end(file);
      return true;
    }
    if (req.method === 'POST' && p === '/v1/install/check') {
      if (tooMany(tries, 'check:' + from, 60, 600)) { json(res, 429, 'Too many tries. Wait a few minutes.'); return true; }
      const b = await body(req);
      const hit = tokenOk(b.token) && hwidOk(b.hwid) ? find(b.token) : null;
      if (!hit) { json(res, 404, 'This installer is not valid.'); return true; }
      const why = refusal(hit.r, b.hwid);
      if (why) { json(res, why.includes('another computer') ? 403 : 410, why); return true; }
      const a = app();
      if (!a) { json(res, 503, 'The server has no Grape to install yet.'); return true; }
      json(res, 200, { ok: true, version: a.version, size: a.size });          // nothing is used up by asking
      return true;
    }
    if (req.method === 'POST' && p === '/v1/install/claim') {
      if (tooMany(tries, 'claim:' + from, 20, 600)) { json(res, 429, 'Too many tries. Wait a few minutes.'); return true; }
      const b = await body(req);
      const hit = tokenOk(b.token) && hwidOk(b.hwid) ? find(b.token) : null;
      if (!hit) { json(res, 404, 'This installer is not valid.'); return true; }
      const why = refusal(hit.r, b.hwid);
      if (why) { json(res, why.includes('another computer') ? 403 : 410, why); return true; }
      if (hit.r.claim && hit.r.claim.count >= MAX_CLAIMS) { json(res, 429, 'This installer was started too many times. Ask for a new one.'); return true; }
      const a = app();
      if (!a) { log('installer: payload/Grape.exe is missing'); json(res, 503, 'The server has no Grape to install yet.'); return true; }
      if (!hit.r.claim) hit.r.claim = { hwid: b.hwid, at: Date.now(), count: 0 };
      hit.r.claim.count++;
      const ticket = crypto.randomBytes(24).toString('base64url');
      hit.r.ticket = { hash: ticketHash(ticket), until: Date.now() + TICKET_MS, served: false };
      hit.r.delivered = false;
      write(FILE, hit.db);
      log(`installer: ${hit.id} taken by computer ${b.hwid.slice(0, 10)} from ${from} (try ${hit.r.claim.count})`);
      json(res, 200, { ticket, size: a.size, sha256: a.sha256, version: a.version });
      return true;
    }
    if (req.method === 'GET' && p.startsWith('/v1/install/file/')) {
      if (tooMany(tries, 'file:' + from, 30, 600)) { json(res, 429, 'Too many tries. Wait a few minutes.'); return true; }
      const ticket = p.slice('/v1/install/file/'.length);
      const want = tokenOk(ticket) ? ticketHash(ticket) : '';
      const db = read(FILE);
      const id = want && Object.keys(db).find((k) => db[k].ticket && db[k].ticket.hash === want);
      const r = id && db[id];
      if (!r || r.revoked || r.used_at || r.ticket.served || r.ticket.until < Date.now()) { json(res, 403, 'This download is not valid any more. Start the installer again.'); return true; }
      const a = app();
      if (!a) { json(res, 503, 'The server has no Grape to install yet.'); return true; }
      r.ticket.served = true;
      write(FILE, db);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': a.size, 'X-Grape-Sha256': a.sha256, 'Cache-Control': 'no-store' });
      res.on('finish', () => {
        try { const now = read(FILE); if (now[id]) { now[id].delivered = true; write(FILE, now); } } catch (e) { log('installer: could not note a delivery (' + e.message + ')'); }
      });
      res.end(a.bytes);
      return true;
    }
    if (req.method === 'POST' && p === '/v1/install/done') {
      const b = await body(req);
      const hit = tokenOk(b.token) && hwidOk(b.hwid) ? find(b.token) : null;
      if (!hit || !hit.r.claim || hit.r.claim.hwid !== b.hwid || hit.r.revoked) { json(res, 403, 'This installer is not valid.'); return true; }
      if (hit.r.used_at) { json(res, 200, { done: true }); return true; }       // said twice
      if (!hit.r.delivered) { json(res, 409, 'Grape was not fully sent.'); return true; }
      hit.r.used_at = Date.now();
      hit.r.ticket = null;
      write(FILE, hit.db);
      log(`installer: ${hit.id} used by computer ${b.hwid.slice(0, 10)}: it will not work again`);
      alert('installer-used', `An installer was used (${hit.r.note || hit.id}) on computer ${b.hwid.slice(0, 10)}.`);
      json(res, 200, { done: true });
      return true;
    }
    return false;
  }

  return { route, make, list, revoke, issueFor, quota, status, app };
};
module.exports.MAGIC = MAGIC;
