'use client';
// The buy window: a plan, paid in USDT (BEP20) or Litecoin. Every "Buy" on the site opens it (BuyButton). It asks the
// server (/api/pay) for the plans and who is logged in, makes a payment with its own address, and then listens on a
// WebSocket (/v1/pay/ws): the server pushes every change - seen, each confirmation, paid - the moment it happens. If the
// socket cannot be opened, it looks every 15 s instead. Buying happens here only - never in the program.
import { useCallback, useEffect, useRef, useState } from 'react';

const OPEN = 'grape-buy';
const KEEP = 'grape-payment';                   // the payment that is open, so the window finds it again
const FINAL = ['paid', 'expired', 'error'];

/** A button (a link without scripts) that opens the buy window, with a plan picked. */
export function BuyButton({ plan, className, children }) {
  return (
    <a className={className} href={'/?buy=' + encodeURIComponent(plan || '')} onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent(OPEN, { detail: { plan } })); }}>{children}</a>
  );
}

const Ic = ({ name }) => <i className="ic" style={{ '--i': `url(/grape/icons/${name}.svg)` }} />;

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* the fallback */ }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  } catch { return false; }
}

function left(ms) {
  if (ms <= 0) return '0:00';
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
  return m + ':' + String(s).padStart(2, '0');
}

export function BuyModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);          // {ready, plans, coins, user}
  const [plan, setPlan] = useState('');
  const [coin, setCoin] = useState('');
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [now, setNow] = useState(Date.now());
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const before = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  const loadOrder = useCallback(async (id) => {
    try {
      const r = await fetch('/api/pay?id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (!r.ok) { if (r.status === 404 || r.status === 401) localStorage.removeItem(KEEP); return null; }
      const j = await r.json();
      setOrder(j.order);
      if (j.user) setState((s) => (s ? { ...s, user: j.user } : s));
      if (FINAL.includes(j.order.status)) localStorage.removeItem(KEEP);
      return j.order;
    } catch { return null; }
  }, []);

  // opening: what can be bought, and the payment still open (if there is one)
  useEffect(() => {
    const show = async (wanted) => {
      before.current = document.activeElement;
      setError(''); setCopied(''); setOrder(null); setState(null); setOpen(true);
      try {
        const s = await (await fetch('/api/pay', { cache: 'no-store' })).json();
        setState(s);
        const first = (s.plans || []).find((p) => p.id === wanted) || (s.plans || []).find((p) => p.id === 'month') || (s.plans || [])[0];
        setPlan(first ? first.id : '');
        setCoin((s.coins || [])[0] ? s.coins[0].id : '');
        const kept = localStorage.getItem(KEEP);
        if (kept && s.user) await loadOrder(kept);
      } catch {
        setError('Could not reach the server. Check your connection and try again.');
      }
    };
    const onOpen = (e) => show(e.detail && e.detail.plan);
    window.addEventListener(OPEN, onOpen);
    const asked = new URLSearchParams(window.location.search).get('buy');
    if (asked !== null) {                                              // back from Discord, or a shared link
      show(asked);
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
    return () => window.removeEventListener(OPEN, onOpen);
  }, [loadOrder]);

  // while a payment is open: the server pushes its changes down a WebSocket (or, without one, it is looked at every 15 s)
  const liveId = open && order && !FINAL.includes(order.status) ? order.id : null;
  useEffect(() => {
    if (!liveId) return undefined;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    let ws = null, poll = null, stopped = false;
    const fallback = () => { if (!poll && !stopped) poll = setInterval(() => loadOrder(liveId), 15000); };
    try {
      ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/v1/pay/ws?id=${encodeURIComponent(liveId)}`);
      ws.onmessage = (m) => {
        try {
          const j = JSON.parse(m.data);
          if (j.type !== 'order' || !j.order || j.order.id !== liveId) return;
          setOrder(j.order);
          if (FINAL.includes(j.order.status)) localStorage.removeItem(KEEP);
        } catch { /* not for us */ }
      };
      ws.onclose = () => { if (!stopped) fallback(); };
    } catch { fallback(); }
    return () => { stopped = true; clearInterval(clock); if (poll) clearInterval(poll); if (ws) ws.close(); };
  }, [liveId, loadOrder]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const keys = (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab' || !dialog.current) return;
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

  const pay = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, coin }) });
      const j = await r.json().catch(() => ({ error: 'The server did not answer. Try again.' }));
      if (!r.ok) setError(j.error || 'That did not work. Try again.');
      else { setOrder(j.order); localStorage.setItem(KEEP, j.order.id); }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    setBusy(false);
  };

  const copy = async (text, what) => {
    if (await copyText(text)) { setCopied(what); setTimeout(() => setCopied(''), 1600); } else setError('Could not copy: select it and copy it yourself.');
  };

  const download = () => { close(); setTimeout(() => window.dispatchEvent(new CustomEvent('grape-download')), 50); };

  if (!open) return null;
  const user = state && state.user;
  const chosen = state && (state.plans || []).find((p) => p.id === plan);
  const chosenCoin = state && (state.coins || []).find((c) => c.id === coin);
  const login = '/login/discord?back=' + encodeURIComponent('/?buy=' + plan);

  let body;
  if (!state && !error) {
    body = <p className="dl-hint">Loading...</p>;
  } else if (state && !state.ready) {
    body = <p className="dl-error" role="alert">Buying is not open yet. Ask in our Discord for a key.</p>;
  } else if (order) {
    const timeLeft = order.expires - now;
    const status = order.status === 'waiting' && timeLeft <= 0 ? 'expired' : order.status;
    body = (
      <>
        {status === 'paid' ? (
          <div className="buy-done">
            <span className="buy-check"><Ic name="check" /></span>
            <h3>Payment received</h3>
            <p>{order.plan_name} were added to your account{user && user.name ? ', ' + user.name : ''}. Download Grape and log in with the same Discord account.</p>
            <button className="btn main" onClick={download}>Download Grape</button>
          </div>
        ) : status === 'expired' ? (
          <div className="buy-done">
            <h3>This payment expired</h3>
            <p>Nothing arrived in time. If you sent it anyway, it will still be counted when it arrives; otherwise start a new one.</p>
            <button className="btn main" onClick={() => { localStorage.removeItem(KEEP); setOrder(null); }}>Start a new payment</button>
          </div>
        ) : status === 'error' ? (
          <div className="buy-done">
            <h3>Your payment arrived</h3>
            <p>But the time could not be added by itself. We have been told: ask in our Discord and it will be sorted out.</p>
          </div>
        ) : (
          <>
            <div className="buy-amount">
              <div>
                <span className="buy-label">Send exactly</span>
                <b>{order.amount} {order.symbol}</b>
                <span className="buy-sub">{order.plan_name} · ${order.usd}</span>
              </div>
              <button className="buy-copy" onClick={() => copy(order.amount, 'amount')}><Ic name={copied === 'amount' ? 'check' : 'copy'} />{copied === 'amount' ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="buy-pay">
              {order.qr && <div className="buy-qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: order.qr }} />}
              <div className="buy-where">
                <span className="buy-label">To this {order.symbol === 'LTC' ? 'Litecoin' : 'BEP20'} address</span>
                <code className="buy-address">{order.address}</code>
                <button className="buy-copy" onClick={() => copy(order.address, 'address')}><Ic name={copied === 'address' ? 'check' : 'copy'} />{copied === 'address' ? 'Copied' : 'Copy address'}</button>
              </div>
            </div>
            <p className="buy-warn">
              {order.symbol === 'LTC'
                ? 'Send only Litecoin (LTC) to this address.'
                : 'Send only USDT on BNB Smart Chain (BEP20). USDT sent on another network (TRON, Ethereum...) is lost.'}
            </p>
            <div className="buy-status" role="status">
              <span className="buy-dot" />
              <span>
                {status === 'seen' ? `Payment seen. Waiting for ${order.confirmations} confirmations...`
                  : status === 'partial' ? `Only ${order.received} ${order.symbol} arrived. Send the rest (${order.amount} in all) to the same address.`
                  : `Waiting for your payment · ${left(timeLeft)} left`}
              </span>
            </div>
            <div className="buy-links">
              <a href={order.explorer} target="_blank" rel="noreferrer">View the address<Ic name="arrow-up-right" /></a>
              {status === 'waiting' && <button className="buy-link" onClick={() => { localStorage.removeItem(KEEP); setOrder(null); }}>Pay another way</button>}
            </div>
          </>
        )}
      </>
    );
  } else if (state) {
    body = (
      <>
        <p className="dl-label">Pick your time</p>
        <div className="buy-plans" role="radiogroup" aria-label="Plan">
          {state.plans.map((p) => (
            <button key={p.id} role="radio" aria-checked={plan === p.id} className={'buy-plan' + (plan === p.id ? ' on' : '')} onClick={() => setPlan(p.id)}>
              <span>{p.name}</span><b>{p.price || '$' + p.usd}</b>
            </button>
          ))}
        </div>
        <p className="dl-label">Pay with</p>
        <div className="dl-rows" role="radiogroup" aria-label="Coin">
          {state.coins.map((c) => (
            <button key={c.id} role="radio" aria-checked={coin === c.id} className={'dl-row buy-coin' + (coin === c.id ? ' on' : '')} onClick={() => setCoin(c.id)}>
              <span className={'dl-icon coin-' + c.id}>{c.symbol === 'USDT' ? '₮' : 'Ł'}</span>
              <span className="dl-words"><b>{c.name}</b><span>{c.network}</span></span>
              <span className="buy-radio" aria-hidden="true" />
            </button>
          ))}
        </div>
        {!user ? (
          <a className="dl-row buy-login" href={login}>
            <span className="dl-icon"><Ic name="discord" /></span>
            <span className="dl-words"><b>Continue with Discord</b><span>The time goes onto your Discord account.</span></span>
            <Ic name="chevron-right" />
          </a>
        ) : (
          <button className="btn main buy-go" disabled={busy || !chosen || !chosenCoin} onClick={pay}>
            {busy ? 'Making your payment...' : `Pay ${chosen ? chosen.price || '$' + chosen.usd : ''} with ${chosenCoin ? chosenCoin.symbol : ''}`}
          </button>
        )}
        {user && <p className="dl-small">Logged in as {user.name}. Not you? <a href="/logout">Log out</a></p>}
      </>
    );
  }

  return (
    <div className="dl-modal">
      <div className="dl-backdrop" onClick={close} />
      <div className="dl-dialog" role="dialog" aria-modal="true" aria-labelledby="buy-title" ref={dialog}>
        <button className="dl-close" onClick={close} aria-label="Close" ref={closeButton}><Ic name="x" /></button>
        <h2 id="buy-title">{order ? 'Pay for Grape' : 'Buy Grape'}</h2>
        {body}
        {error && <p className="dl-error" role="alert">{error}</p>}
        <p className="dl-small">Paying means you agree to the <a href="/terms">Terms of Service</a>. Nothing renews by itself.</p>
      </div>
    </div>
  );
}
