// Captures a view of a running Grape window into public/site/live (the landing page's live windows): the app's own
// markup and stylesheets as drawn, without scripts. Start Grape with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
// --remote-debugging-port=<port>, log in, then:  node scripts/capture-live.mjs <port> public/site/live/<view>.html "<js that opens the view>"
// Check the file for anything personal before publishing it.
import { writeFileSync } from 'node:fs';
const [port, out, setup] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((p) => p.type === 'page' && !p.url.includes('injected.html') && !p.url.includes('log.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const r = JSON.parse(m.data); if (wait.has(r.id)) { wait.get(r.id)(r); wait.delete(r.id); } };
const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
const run = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
await run(setup || '1');
await new Promise((r) => setTimeout(r, 800));
const html = await run(`(() => {
  const doc = document.documentElement.cloneNode(true);
  const drop = 'script, link, [hidden], .toasts, .tip, .splash, .launch-gate, .monaco-editor canvas, .monaco-editor textarea, .native-edit-context, .ime-text-area, .monaco-aria-container, .clients-backdrop:not(.on), .overflowingContentWidgets';
  doc.querySelectorAll(drop).forEach((n) => n.remove());
  doc.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
  doc.querySelectorAll('input').forEach((n) => { n.setAttribute('value', n.value); n.setAttribute('tabindex', '-1'); });
  doc.querySelectorAll('button, a').forEach((n) => n.setAttribute('tabindex', '-1'));
  const head = doc.querySelector('head');
  head.insertAdjacentHTML('afterbegin', '<meta charset="utf-8"><base href="/grape/"><meta name="robots" content="noindex">'
    + '<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="pages.css"><link rel="stylesheet" href="vs/editor/editor.main.css">'
    + '<style>html,body{pointer-events:none!important;overflow:hidden!important}*{animation:none!important;transition:none!important}</style>');
  doc.querySelectorAll('[inert]').forEach((n) => n.removeAttribute('inert'));
  return '<!doctype html>\\n' + doc.outerHTML;
})()`);
writeFileSync(out, html);
console.log(out, Math.round(html.length / 1024) + ' KB');
await send('Emulation.clearDeviceMetricsOverride', {});
ws.close();
