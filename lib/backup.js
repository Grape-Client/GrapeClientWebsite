// An encrypted copy of the data folder (accounts, users, keys, installers, settings, the admin hash, session.key and the
// resource key), so that losing the VPS does not lock everyone out - and a copy that is stolen opens nothing.
//
//   GRAPE_BACKUP_PASSWORD=... node server.js backup grape-2026-11-25.grapebak
//   GRAPE_BACKUP_PASSWORD=... node server.js restore grape-2026-11-25.grapebak [--force]
//
//   file: "GRAPEBAK1" | salt(16) | iv(12) | AES-256-GCM(gzip(JSON {name: base64})) | tag(16)   key = scrypt(password, salt)
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAGIC = Buffer.from('GRAPEBAK1');
const keyFor = (password, salt) => crypto.scryptSync(String(password), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const skip = (name) => name.endsWith('.saving') || name === 'server.log' || name.startsWith('.');

function pack(dataDir, password) {
  if (String(password || '').length < 10) throw new Error('The backup password must be at least 10 characters (set GRAPE_BACKUP_PASSWORD).');
  const files = {};
  for (const name of fs.readdirSync(dataDir)) {
    const file = path.join(dataDir, name);
    if (skip(name) || !fs.statSync(file).isFile()) continue;
    files[name] = fs.readFileSync(file).toString('base64');
  }
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(password, salt), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(files)))), cipher.final()]);
  return { bytes: Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]), count: Object.keys(files).length };
}

function unpack(bytes, password) {
  if (bytes.length < MAGIC.length + 16 + 12 + 16 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('That is not a Grape backup.');
  const salt = bytes.subarray(MAGIC.length, MAGIC.length + 16), iv = bytes.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const body = bytes.subarray(MAGIC.length + 28, bytes.length - 16), tag = bytes.subarray(bytes.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(password, salt), iv);
  decipher.setAuthTag(tag);
  let files;
  try { files = JSON.parse(zlib.gunzipSync(Buffer.concat([decipher.update(body), decipher.final()])).toString('utf8')); } catch { throw new Error('Wrong password, or the backup is damaged.'); }
  const out = {};
  for (const [name, text] of Object.entries(files)) {
    if (skip(name) || name !== path.basename(name)) throw new Error('The backup holds a file name that is not allowed.');
    out[name] = Buffer.from(String(text), 'base64');
  }
  return out;
}

/** Writes the backup to `file` (refuses to replace one). */
function backup(dataDir, file, password) {
  const { bytes, count } = pack(dataDir, password);
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return count;
}

/** Puts a backup's files into `dataDir`; a folder that already holds data is left alone unless `force`. */
function restore(dataDir, file, password, force) {
  const files = unpack(fs.readFileSync(file), password);
  fs.mkdirSync(dataDir, { recursive: true });
  const present = fs.readdirSync(dataDir).filter((n) => !skip(n) && fs.statSync(path.join(dataDir, n)).isFile());
  if (present.length && !force) throw new Error(`${dataDir} already holds ${present.length} file(s). Add --force to replace them (stop the server first).`);
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(dataDir, name);
    const temp = `${target}.${process.pid}.saving`;
    fs.writeFileSync(temp, bytes, { mode: 0o600 });
    fs.renameSync(temp, target);
  }
  return Object.keys(files).length;
}

module.exports = { backup, restore, pack, unpack };
