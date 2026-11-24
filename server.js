// Grape's server: one Node process. It answers the loader's WebSocket (/v1/ws) and the login redirects itself (lib/
// core.js), and hands everything else to Next.js: the website's pages, the admin page (/admin-grape) and its API.
//
//   npm run dev          development (Next compiles pages as they are opened)
//   npm run build        build the pages for production, then:
//   npm start            production (node server.js --prod)
//   node server.js <command> ...     the admin commands (lib/cli.js), without starting anything
//
//   GRAPE_PORT (8787) / GRAPE_BIND (127.0.0.1) / GRAPE_DATA (./data) / GRAPE_PUBLIC_URL (the address browsers use)
//   GRAPE_TRUST_PROXY=1  behind nginx or similar on the VPS: the client's address is taken from X-Forwarded-For
//   GRAPE_NO_PAGES=1     only the WebSocket and the redirects, no Next.js (the program's tests)
'use strict';
// production is decided before anything is loaded: the core (the development viewer) and Next.js both read it once
if (process.argv[2] === '--prod') process.env.NODE_ENV = 'production';
const http = require('node:http');
const core = require('./lib/core');

const [command, ...args] = process.argv.slice(2);
if (command === '--prod') {
  serve();
} else if (command) {
  if (!require('./lib/cli')(core, command, args)) {
    console.error('Unknown command. See lib/cli.js.');
    process.exit(1);
  }
} else {
  serve();
}

// One bad request or one reset connection must not end a server that others are using: it is logged, and goes on.
process.on('uncaughtException', (e) => core.log('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => core.log('unhandled: ' + (e && e.stack || e)));

function serve() {
  // The pages and routes of Next.js find this very instance here (with its open connections and logins waiting).
  globalThis.grape = core;
  core.start();

  const pages = process.env.GRAPE_NO_PAGES !== '1';
  const dev = process.env.NODE_ENV !== 'production';
  let handle = null, upgradeNext = null;
  let ready = Promise.resolve();
  if (pages) {
    const next = require('next');
    const app = next({ dev, dir: __dirname, hostname: core.BIND, port: core.PORT });
    ready = app.prepare().then(() => {
      handle = app.getRequestHandler();
      upgradeNext = typeof app.getUpgradeHandler === 'function' ? app.getUpgradeHandler() : null;
      core.log(`pages ready (${dev ? 'development' : 'production'})`);
    });
  }

  const server = http.createServer(async (req, res) => {
    // Who is asking, as this server saw it (the header of that name, if the browser sent one, is overwritten).
    req.headers['x-grape-ip'] = core.ipOf(req);
    try {
      if (await core.http(req, res)) return;
      if (!pages) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found.'); }
      await ready;
      await handle(req, res);
    } catch (e) {
      core.log('http error: ' + (e && e.stack || e));
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('The server had a problem.'); }
    }
  });
  server.on('upgrade', (req, sock, head) => {
    sock.on('error', () => sock.destroy());            // a reset socket must never end the server (this covers Next's too)
    if (req.url === '/v1/ws') return core.upgrade(req, sock);
    if (req.url.startsWith('/v1/pay/ws')) return core.payUpgrade(req, sock);     // the buy window: its payment, pushed live
    if (upgradeNext) return upgradeNext(req, sock, head);           // Next's own (the page reloads while developing)
    sock.destroy();
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.listen(core.PORT, core.BIND, () => {
    core.log(`Grape server listening on http://${core.BIND}:${core.PORT}  (data: ${core.DATA}, public: ${core.publicUrl()})`);
    if (pages) core.log(`admin page: ${core.publicUrl()}/admin-grape`);
    const setup = core.setupLink();
    if (setup && pages) core.log(`no admin password yet - set it here (this link works once): ${setup}`);
    if (core.DEV) core.log(`development viewer: http://${core.BIND}:${core.PORT}/view-process  (GRAPE_DEV=0 switches it off)`);
  });
}
