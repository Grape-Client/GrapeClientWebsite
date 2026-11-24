'use client';
// The download popup. Every "Download" on the site opens it (DownloadButton); it asks the server who is logged in
// (/api/installer), shows the way to the installer - log in with Discord, then download - and shows what went wrong
// inside the popup, never on a page of its own. An old link to /download?... opens it too (?download=1).
import { useCallback, useEffect, useRef, useState } from 'react';

const OPEN = 'grape-download';
const LOGIN = '/login/discord?back=' + encodeURIComponent('/install?download=1');

/** A button (a link without scripts) that opens the popup. */
export function DownloadButton({ className, children, disabled }) {
  if (disabled) return <a className={className} aria-disabled="true">{children}</a>;
  return (
    <a className={className} href="/install?download=1" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent(OPEN)); }}>{children}</a>
  );
}

const Ic = ({ name }) => <i className="ic" style={{ '--i': `url(/grape/icons/${name}.svg)` }} />;
const WindowsMark = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
    <path d="M2 2h9.5v9.5H2zM12.5 2H22v9.5h-9.5zM2 12.5h9.5V22H2zM12.5 12.5H22V22h-9.5z" fill="currentColor" />
  </svg>
);

export function DownloadModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);          // what /api/installer said: user, ready, version, size, quota
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');              // the installer's address once it was made
  const [key, setKey] = useState('');                // a key being typed in
  const [redeeming, setRedeeming] = useState(false);
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const before = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/installer', { cache: 'no-store' });
      setState(await r.json());
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
  }, []);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const show = () => { before.current = document.activeElement; setError(''); setLink(''); setState(null); setOpen(true); load(); };
    window.addEventListener(OPEN, show);
    if (new URLSearchParams(window.location.search).get('download') === '1') {      // back from Discord, or an old link
      show();
      window.history.replaceState(null, '', window.location.pathname);
    }
    return () => window.removeEventListener(OPEN, show);
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const keys = (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab' || !dialog.current) return;                  // Tab stays inside the popup
      const items = [...dialog.current.querySelectorAll('a[href], button:not([disabled])')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', keys);
      if (before.current && before.current.focus) before.current.focus();
    };
  }, [open, close]);

  /** GRAPE-XXXXX-XXXXX-XXXXX-XXXXX as it is typed: letters and digits only, in groups of five. */
  const shape = (text) => {
    const body = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 25);
    return body.match(/.{1,5}/g)?.join('-') || '';
  };
  const redeem = async (e) => {
    e.preventDefault();
    setRedeeming(true);
    setError('');
    try {
      const r = await fetch('/api/installer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'redeem', code: key }) });
      const j = await r.json().catch(() => ({ error: 'The server did not answer. Try again.' }));
      if (!r.ok) setError(j.error || 'That did not work. Try again.');
      else { setState(j); setKey(''); }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    setRedeeming(false);
  };

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/installer', { method: 'POST' });
      const j = await r.json().catch(() => ({ error: 'The server did not answer. Try again.' }));
      if (!r.ok) {
        setError(j.error || 'That did not work. Try again.');
        if (j.login || j.quota || j.needs_time) setState((s) => ({ ...(s || {}), ...j }));
      } else {
        setLink(j.url);
        if (j.quota) setState((s) => ({ ...(s || {}), quota: j.quota }));
        window.location.assign(j.url);                                  // the file arrives as a download: the page stays
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    setBusy(false);
  };

  if (!open) return null;
  const user = state && state.user;
  const ready = !state || state.ready;
  const size = state && state.size ? (state.size / 1048576).toFixed(1) + ' MB' : '';
  const facts = [state && state.version && 'Version ' + state.version, size, 'works once, on one computer'].filter(Boolean).join('  ·  ');
  const left = state && state.quota && state.quota.limit > 0 ? state.quota.left : null;
  const active = !!(user && user.active);
  const needsTime = !!(user && !user.active && !user.revoked);
  const timeLeft = (u) => {
    if (!u.active) return u.revoked ? 'Switched off' : 'No time left';
    if (u.expires === null) return 'No end date';
    const ms = u.expires - Date.now();
    const d = Math.floor(ms / 864e5), h = Math.max(1, Math.floor(ms / 36e5) % 24);
    return (d > 0 ? d + ' day' + (d === 1 ? '' : 's') : h + ' hour' + (h === 1 ? '' : 's')) + ' left';
  };

  return (
    <div className="dl-modal">
      <div className="dl-backdrop" onClick={close} />
      <div className="dl-dialog" role="dialog" aria-modal="true" aria-labelledby="dl-title" ref={dialog}>
        <button className="dl-close" onClick={close} aria-label="Close" ref={closeButton}><Ic name="x" /></button>
        <h2 id="dl-title">Download Grape</h2>

        <div className="dl-promo">
          <div>
            <h3>Need time on your account?</h3>
            <p>Grape runs on keys. Every plan is all of Grape, they only differ in how long.</p>
          </div>
          <a className="btn main" href="/?buy=month" onClick={(e) => { e.preventDefault(); close(); setTimeout(() => window.dispatchEvent(new CustomEvent('grape-buy', { detail: { plan: 'month' } })), 50); }}>Buy time</a>
        </div>

        <p className="dl-label">Get your installer</p>
        <p className="dl-hint">Log in with Discord, and have time on your account. The installer is made for you and works once.</p>

        <div className="dl-rows">
          {!state && !error ? (
            <div className="dl-row" aria-busy="true"><span className="dl-icon"><Ic name="clock" /></span><span className="dl-words"><b>Checking...</b></span></div>
          ) : user ? (
            <div className="dl-row done">
              <span className="dl-icon">{user.avatar ? <img src={user.avatar} alt="" /> : <Ic name="check" />}</span>
              <span className="dl-words"><b>Logged in as {user.name}</b><span>{timeLeft(user)}. Not you? <a href="/logout">Log out</a></span></span>
              <Ic name="check" />
            </div>
          ) : (
            <a className="dl-row" href={LOGIN}>
              <span className="dl-icon"><Ic name="discord" /></span>
              <span className="dl-words"><b>Continue with Discord</b><span>Log in, so the installer is made for you.</span></span>
              <Ic name="chevron-right" />
            </a>
          )}

          {needsTime && (
            <form className="dl-row redeem" onSubmit={redeem}>
              <span className="dl-icon"><Ic name="sparkles" /></span>
              <span className="dl-words">
                <b>Redeem a key</b>
                <input value={key} onChange={(e) => setKey(shape(e.target.value))} placeholder="GRAPE-XXXXX-XXXXX-XXXXX-XXXXX" maxLength={29} spellcheck="false" autoComplete="off" aria-label="License key" />
              </span>
              <button className="btn main" disabled={redeeming || key.replace(/-/g, '').length < 25}>{redeeming ? '...' : 'Redeem'}</button>
            </form>
          )}

          {link ? (
            <div className="dl-row done">
              <span className="dl-icon"><Ic name="download" /></span>
              <span className="dl-words"><b>Your download is starting</b><span>Not starting? <a href={link}>Download it again</a>. Then run it and log in to Grape.</span></span>
            </div>
          ) : (
            <button className="dl-row" disabled={!active || busy || !ready} onClick={download}>
              <span className="dl-icon"><WindowsMark /></span>
              <span className="dl-words">
                <b>{busy ? 'Making your installer...' : ready ? 'Download for Windows' : 'Download coming soon'}</b>
                <span>{!ready ? 'The installer is not ready yet.' : !user ? 'Log in first.' : !active ? (user.revoked ? 'Your account is switched off.' : 'Redeem a key first.') : facts}</span>
              </span>
              <Ic name="chevron-right" />
            </button>
          )}
        </div>

        {error && <p className="dl-error" role="alert">{error}</p>}
        {!error && left !== null && active && !link && <p className="dl-small">You can make {left} more installer{left === 1 ? '' : 's'} today.</p>}
        <p className="dl-small">By downloading Grape you agree to the <a href="/terms">Terms of Service</a>.</p>
      </div>
    </div>
  );
}
