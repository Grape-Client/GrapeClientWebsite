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
    <path d="M3 5.6 10.4 4.6v6.9H3zM11.6 4.4 21 3v8.5h-9.4zM3 12.5h7.4v6.9L3 18.4zM11.6 12.5H21V21l-9.4-1.3z" fill="currentColor" />
  </svg>
);

export function DownloadModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);          // what /api/installer said: user, ready, version, size, quota
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');              // the installer's address once it was made
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

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/installer', { method: 'POST' });
      const j = await r.json().catch(() => ({ error: 'The server did not answer. Try again.' }));
      if (!r.ok) {
        setError(j.error || 'That did not work. Try again.');
        if (j.login || j.quota) setState((s) => ({ ...(s || {}), ...j }));
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
          <a className="btn main" href="/#plans" onClick={close}>See plans</a>
        </div>

        <p className="dl-label">Get your installer</p>
        <p className="dl-hint">Two quick steps. The installer is made for you and works once.</p>

        <div className="dl-rows">
          {!state && !error ? (
            <div className="dl-row" aria-busy="true"><span className="dl-icon"><Ic name="clock" /></span><span className="dl-words"><b>Checking...</b></span></div>
          ) : user ? (
            <div className="dl-row done">
              <span className="dl-icon">{user.avatar ? <img src={user.avatar} alt="" /> : <Ic name="check" />}</span>
              <span className="dl-words"><b>Logged in as {user.name}</b><span>Not you? <a href="/logout">Log out</a></span></span>
              <Ic name="check" />
            </div>
          ) : (
            <a className="dl-row" href={LOGIN}>
              <span className="dl-icon"><Ic name="discord" /></span>
              <span className="dl-words"><b>Continue with Discord</b><span>Log in, so the installer is made for you.</span></span>
              <Ic name="chevron-right" />
            </a>
          )}

          {link ? (
            <div className="dl-row done">
              <span className="dl-icon"><Ic name="download" /></span>
              <span className="dl-words"><b>Your download is starting</b><span>Not starting? <a href={link}>Download it again</a>. Then run it and log in to Grape.</span></span>
            </div>
          ) : (
            <button className="dl-row" disabled={!user || busy || !ready} onClick={download}>
              <span className="dl-icon"><WindowsMark /></span>
              <span className="dl-words">
                <b>{busy ? 'Making your installer...' : ready ? 'Download for Windows' : 'Download coming soon'}</b>
                <span>{!ready ? 'The installer is not ready yet.' : user ? facts : 'Log in first.'}</span>
              </span>
              <Ic name="chevron-right" />
            </button>
          )}
        </div>

        {error && <p className="dl-error" role="alert">{error}</p>}
        {!error && left !== null && user && !link && <p className="dl-small">You can make {left} more installer{left === 1 ? '' : 's'} today.</p>}
        <p className="dl-small">By downloading Grape you agree to the <a href="/terms">Terms of Service</a>.</p>
      </div>
    </div>
  );
}
