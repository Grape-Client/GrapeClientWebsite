'use client';
// The admin page. Built from the Grape window's own pieces (public/grape/style.css and pages.css, copied from the app):
// the title bar with its page tabs, a page's side bar with its sections, cards of rows, switches, choices, the toasts
// and the question box. Everything it does goes through /api/admin/<action> (lib/core.js adminApi).
import { useCallback, useEffect, useMemo, useState } from 'react';

// ------------------------------------------------------------------ small pieces

const Ic = ({ name }) => <i className="ic" style={{ '--i': `url(/grape/icons/${name}.svg)` }} />;

let onExpired = null;          // the window's way back to the sign-in form when the admin cookie has ended

async function call(action, body) {
  const r = await fetch('/api/admin/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const json = await r.json().catch(() => ({ error: 'The server did not answer.' }));
  if (!r.ok) {
    if (r.status === 401 && onExpired && !['state', 'setup', 'login'].includes(action)) onExpired();
    const e = new Error(json.error || 'That did not work.');
    e.status = r.status;
    throw e;
  }
  return json;
}

/** Puts text on the clipboard. A page opened over plain http on an address that is not this computer has no clipboard
 *  API: a hidden text box does it then. False when neither works (the caller says so). */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* the fallback below */ }
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

function span(ms) {
  if (ms <= 0) return '0m';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const dateOf = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-');
const timeOf = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}
/** What a user's time says: "12d 4h left", "Lifetime", "Expired", ... */
function timeLeft(u) {
  if (u.revoked) return 'Switched off';
  if (!u.plan) return 'No plan';
  if (u.expires === null) return 'Lifetime';
  return u.active ? span(u.expires - Date.now()) + ' left' : 'Expired';
}

/** A row of a card: icon, words, and whatever is at the right. */
function Row({ icon, title, sub, children, indent, onClick, className }) {
  return (
    <div className={'set-row' + (indent ? ' indent' : '') + (onClick ? ' admin-click' : '') + (className ? ' ' + className : '')} onClick={onClick}>
      {icon && <Ic name={icon} />}
      <div className="set-words">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, label }) {
  return (
    <button className={'green-switch' + (on ? ' on' : '')} role="switch" aria-checked={on} aria-label={label} onClick={(e) => { e.stopPropagation(); onChange(!on); }}>
      <i />
    </button>
  );
}

function Choice({ values, value, onChange, label }) {
  return (
    <div className="set-choice" role="group" aria-label={label}>
      {values.map(([v, text]) => (
        <button key={v} className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

function Stepper({ value, min, max, onChange, label }) {
  return (
    <div className="set-number">
      {/* onChange is a state setter: the step works from the latest value, so quick clicks all count */}
      <button aria-label={'Decrease ' + label} disabled={value <= min} onClick={() => onChange((v) => Math.max(min, v - 1))}><Ic name="minus" /></button>
      <b>{value}</b>
      <button aria-label={'Increase ' + label} disabled={value >= max} onClick={() => onChange((v) => Math.min(max, v + 1))}><Ic name="plus" /></button>
    </div>
  );
}

function Face({ user }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="discord-face">
      {user.avatar && !broken ? <img src={user.avatar} alt="" draggable={false} onError={() => setBroken(true)} /> : (user.name || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

// ------------------------------------------------------------------ the toasts and the question box, as the app has them

function useDialogs() {
  const [toasts, setToasts] = useState([]);
  const [ask, setAsk] = useState(null);
  const toast = useCallback((text, kind) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const confirm = useCallback((q) => new Promise((resolve) => setAsk({ ...q, resolve })), []);
  const answer = (yes) => { ask.resolve(yes); setAsk(null); };
  useEffect(() => {
    if (!ask) return undefined;
    const keys = (e) => { if (e.key === 'Escape') answer(false); };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  });
  const view = (
    <>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            {t.kind === 'ok' && <Ic name="check" />}
            <span>{t.text}</span>
            <button aria-label="Close" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}><Ic name="x" /></button>
          </div>
        ))}
      </div>
      {ask && (
        <div className="confirm" onMouseDown={(e) => { if (e.target === e.currentTarget) answer(false); }}>
          <div className="confirm-box" role="dialog" aria-modal="true" aria-label={ask.title}>
            <header>
              <Ic name={ask.icon || 'triangle-alert'} />
              <h3>{ask.title}</h3>
              <span className="grow" />
              <button id="confirm-close" aria-label="Close" onClick={() => answer(false)}><Ic name="x" /></button>
            </header>
            <p>{ask.text}</p>
            <div className="confirm-buttons">
              <button autoFocus onClick={() => answer(false)}>Cancel</button>
              <button className={ask.danger ? 'danger' : 'plain'} onClick={() => answer(true)}>{ask.ok}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
  return { toast, confirm, view };
}

// ------------------------------------------------------------------ signing in

function SignIn({ ready, setup, onIn }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const making = !ready && setup;
  const submit = async (e) => {
    e.preventDefault();
    if (making && password !== again) return setProblem('The two passwords are not the same.');
    setBusy(true);
    setProblem('');
    try {
      await call(making ? 'setup' : 'login', making ? { token: setup, password } : { password });
      if (making) window.history.replaceState(null, '', '/admin-grape');
      onIn();
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };
  return (
    <div className="admin-login">
      <form className="admin-login-box" onSubmit={submit}>
        <img src="/grape/logo.png" alt="" draggable={false} />
        <h1>Grape Admin</h1>
        {!ready && !setup ? (
          <p className="admin-note">No admin password is set yet. Open the link the server printed when it started, or set one on the server: <code>node server.js admin-password &lt;password&gt;</code></p>
        ) : (
          <>
            <p className="admin-note">{making ? 'Choose the admin password. At least 10 characters.' : 'Sign in with the admin password.'}</p>
            <input className="set-input" type="password" autoFocus autoComplete={making ? 'new-password' : 'current-password'} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {making && <input className="set-input" type="password" autoComplete="new-password" placeholder="The same again" value={again} onChange={(e) => setAgain(e.target.value)} />}
            <button className="mc-get admin-primary" disabled={busy || !password}>{busy ? 'One moment...' : making ? 'Set password' : 'Sign in'}</button>
            {problem && <p className="admin-problem">{problem}</p>}
          </>
        )}
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ Home

function Home({ section, data }) {
  if (!data) return <p className="mc-none">Loading...</p>;
  if (section === 'log') {
    return (
      <>
        <h2>Server Log</h2>
        <div className="mc-card set-card admin-log">
          {data.log.length ? data.log.map((line, i) => <div key={i}>{line}</div>) : <p className="mc-none">Nothing logged yet.</p>}
        </div>
      </>
    );
  }
  const yes = (v, good, bad) => <b className={v ? 'good' : 'bad'}>{v ? good : bad}</b>;
  return (
    <>
      <h2>Overview</h2>
      <div className="home-grid">
        <div className="home-card"><span>Users</span><b>{data.users}</b></div>
        <div className="home-card right"><span>Active licenses</span><b>{data.active}</b></div>
        <div className="home-card"><span>Computers</span><b>{data.computers}</b></div>
        <div className="home-card right"><span>Online now</span><b>{data.online}</b></div>
        <div className="home-card"><span>Keys not used yet</span><b>{data.keys_unused}</b></div>
        <div className="home-card right"><span>Keys redeemed</span><b>{data.keys_used}</b></div>
        <div className="home-card wide">
          <div><span>Discord login</span>{yes(data.discord, 'Ready', 'Not set up')}</div>
          <div className="home-right"><span>Agent</span>{yes(data.payload, 'Ready', 'Missing')}</div>
          <div className="home-right"><span>Resource key</span>{yes(data.resource_key, 'Ready', 'Missing')}</div>
          <div className="home-right"><span>Window</span>{yes(data.ui_bundle, 'Ready', 'Missing')}</div>
          <div className="home-right"><span>Installer</span>{yes(data.installer && data.installer.stub && data.installer.app, 'Ready', 'Missing')}</div>
        </div>
        <div className="home-card wide">
          <div><span>Public address</span><b>{data.public_url}</b></div>
          <div className="home-right"><span>Running since</span><b>{ago(data.started)}</b></div>
        </div>
      </div>
      {!data.discord && <p className="admin-hint">Discord login is not set up: until it is, nobody can log in to Grape. Settings &gt; Discord.</p>}
    </>
  );
}

// ------------------------------------------------------------------ Keys

function Keys({ section, plans, ui, made, setMade }) {
  const [plan, setPlan] = useState('month');
  const [count, setCount] = useState(1);
  const [note, setNote] = useState('');
  const [all, setAll] = useState(null);
  const [filter, setFilter] = useState('all');
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => call('keys').then(setAll).catch((e) => ui.toast(e.message)), [ui]);
  useEffect(() => { if (section === 'list') load(); }, [section, load]);
  useEffect(() => { if (plans.length && !plans.some((p) => p.id === plan)) setPlan(plans[0].id); }, [plans, plan]);

  const copy = async (text, what) => { if (await copyText(text)) ui.toast(what + ' copied', 'ok'); else ui.toast('Could not copy: select the text and copy it yourself.'); };
  const make = async () => {
    setBusy(true);
    try {
      const out = await call('make-keys', { plan, count, note });
      setMade(out.keys);
      ui.toast(out.keys.length === 1 ? 'Key made' : out.keys.length + ' keys made', 'ok');
    } catch (e) { ui.toast(e.message); }
    setBusy(false);
  };
  const cancel = async (k) => {
    if (!(await ui.confirm({ icon: 'ban', title: 'Cancel key', text: `Cancel this ${k.plan_name} key${k.note ? ' (' + k.note + ')' : ''}? It can no longer be redeemed.`, ok: 'Cancel key', danger: true }))) return;
    try { await call('cancel-key', { hash: k.hash }); ui.toast('Key cancelled', 'ok'); load(); } catch (e) { ui.toast(e.message); }
  };

  if (section === 'make') {
    const planName = (plans.find((p) => p.id === plan) || {}).name || plan;
    return (
      <>
        <h2>Make Keys</h2>
        <h6>NEW KEYS</h6>
        <div className="mc-card set-card">
          <Row icon="layers" title="Plan" sub="How much time each key adds to an account">
            <Choice label="Plan" value={plan} onChange={setPlan} values={plans.map((p) => [p.id, p.name])} />
          </Row>
          <Row icon="layout-list" title="How Many" sub="Up to 500 at once">
            <div className="admin-count">
              <Choice label="Quick count" value={count} onChange={setCount} values={[[1, '1'], [5, '5'], [10, '10'], [25, '25']]} />
              <Stepper label="count" value={count} min={1} max={500} onChange={setCount} />
            </div>
          </Row>
          <Row icon="pencil" title="Note" sub="Who or what they are for. Only you see it">
            <input className="set-input" value={note} maxLength={80} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
          </Row>
          <Row icon="sparkles" title={`Make ${count} ${planName} key${count === 1 ? '' : 's'}`} sub="Each key can be redeemed once, by one Discord account">
            <button className="mc-get admin-primary" disabled={busy} onClick={make}>{busy ? 'Making...' : 'Make keys'}</button>
          </Row>
        </div>
        {made.length > 0 && (
          <>
            <div className="mc-head"><h6>MADE JUST NOW</h6><span className="grow" /><button className="pg-more" onClick={() => copy(made.join('\n'), made.length === 1 ? 'Key' : 'Keys')}>Copy all<Ic name="copy" /></button></div>
            <div className="mc-card set-card">
              {made.map((k) => (
                <Row key={k} icon="check" title={<code className="admin-key">{k}</code>}>
                  <button className="mc-get" onClick={() => copy(k, 'Key')}>Copy</button>
                </Row>
              ))}
            </div>
            <p className="admin-hint">Copy them now: the server keeps only a fingerprint of each key, not the key itself.</p>
          </>
        )}
      </>
    );
  }

  const wanted = find.trim().toLowerCase();
  const shown = (all || []).filter((k) => (filter === 'all' || (filter === 'unused' ? !k.used_by && !k.revoked : filter === 'used' ? !!k.used_by : k.revoked))
    && (!wanted || (k.plan_name + ' ' + k.note + ' ' + k.used_by_name + ' ' + (k.used_by || '') + ' ' + k.hash).toLowerCase().includes(wanted)));
  return (
    <>
      <h2>All Keys</h2>
      <div className="admin-tools">
        <Choice label="Show" value={filter} onChange={setFilter} values={[['all', 'All'], ['unused', 'Not used'], ['used', 'Redeemed'], ['cancelled', 'Cancelled']]} />
        <input className="set-input" placeholder="Search notes, plans, users..." value={find} onChange={(e) => setFind(e.target.value)} />
        <span className="grow" />
        <button className="mc-get" onClick={load}>Refresh</button>
      </div>
      {!all ? <p className="mc-none">Loading...</p> : !shown.length ? <p className="mc-none">{all.length ? 'No key matches.' : 'No keys yet. Make some in Make Keys.'}</p> : (
        <div className="mc-card set-card">
          {shown.map((k) => (
            <Row key={k.hash} icon={k.revoked ? 'ban' : k.used_by ? 'check' : 'sparkles'}
              title={k.plan_name + (k.note ? '  ·  ' + k.note : '')}
              sub={`Made ${dateOf(k.created)}  ·  ${k.hash.slice(0, 8)}${k.used_by ? `  ·  redeemed ${timeOf(k.used_at)}` : ''}`}>
              <b className={'set-value' + (k.revoked ? ' bad' : k.used_by ? '' : ' good')}>{k.revoked ? 'Cancelled' : k.used_by ? (k.used_by_name || k.used_by) : 'Not used'}</b>
              {!k.used_by && !k.revoked && <button className="mc-get" onClick={() => cancel(k)}>Cancel</button>}
            </Row>
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Users and Computers

function UserDetail({ user, plans, ui, reload }) {
  const [plan, setPlan] = useState(plans[0] ? plans[0].id : 'month');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const act = async (op, value, done) => {
    if (busy) return;                      // a double click is one action, not two (a plan given twice is two plans)
    setBusy(true);
    try { await call('user', { id: user.id, op, value }); ui.toast(done, 'ok'); reload(); } catch (e) { ui.toast(e.message); }
    setBusy(false);
  };
  return (
    <div className="admin-detail">
      <Row icon="power" title="Active" sub="Switched off, the account cannot use Grape on any computer" indent>
        <Switch label="Active" on={!user.revoked} onChange={(on) => act(on ? 'unrevoke' : 'revoke', undefined, on ? 'Switched on' : 'Switched off')} />
      </Row>
      <Row icon="layers" title="Give Plan" sub="Adds the plan's time, as a key would" indent>
        <Choice label="Plan" value={plan} onChange={setPlan} values={plans.map((p) => [p.id, p.name])} />
        <button className="mc-get" disabled={busy} onClick={() => act('grant', plan, 'Plan given')}>Give</button>
      </Row>
      <Row icon="clock" title="Change Time" sub="Days to add, or to take away" indent>
        <Stepper label="days" value={days} min={-365} max={365} onChange={setDays} />
        <button className="mc-get" disabled={busy || !days || user.expires === null} onClick={() => act('extend', days, days > 0 ? `${days} days added` : `${-days} days taken away`)}>{days < 0 ? 'Take away' : 'Add'}</button>
      </Row>
      <Row icon="cpu" title="Computer Lock" sub={user.hwid ? `Locked to pc ${user.hwid} since ${dateOf(user.hwid_set_at)}${user.hwid_reset_at ? ', last moved ' + ago(user.hwid_reset_at) : ''}` : 'Not locked: the next computer that uses it takes it'} indent>
        {user.hwid && <button className="mc-get" disabled={busy} onClick={async () => { if (await ui.confirm({ icon: 'cpu', title: 'Free the lock', text: `Free ${user.name}'s computer lock? The next of their computers that uses Grape takes it, without the 24-hour wait.`, ok: 'Free lock' })) act('reset-hwid', undefined, 'Lock freed'); }}>Free lock</button>}
      </Row>
      <Row icon="unplug" title="Computers" sub={user.computers.length ? user.computers.join(', ') : 'No computer is logged in as this account'} indent />
      {user.plan && (
        <Row icon="trash-2" title="Remove Plan" sub="The account keeps existing, without time" indent>
          <button className="mc-get" disabled={busy} onClick={async () => { if (await ui.confirm({ icon: 'trash-2', title: 'Remove plan', text: `Remove ${user.name}'s ${user.plan_name} plan and all its time?`, ok: 'Remove', danger: true })) act('clear-plan', undefined, 'Plan removed'); }}>Remove</button>
        </Row>
      )}
    </div>
  );
}

function Users({ section, plans, ui }) {
  const [list, setList] = useState(null);
  const [computers, setComputers] = useState(null);
  const [open, setOpen] = useState(null);
  const [find, setFind] = useState('');
  const load = useCallback(() => {
    if (section === 'users') call('users').then(setList).catch((e) => ui.toast(e.message));
    else call('computers').then(setComputers).catch((e) => ui.toast(e.message));
  }, [section, ui]);
  useEffect(() => { load(); }, [load]);
  const wanted = find.trim().toLowerCase();

  if (section === 'computers') {
    const shown = (computers || []).filter((c) => !wanted || (c.id + ' ' + c.user_name + ' ' + (c.user || '') + ' ' + c.hwid).toLowerCase().includes(wanted));
    const logout = async (c) => {
      if (!(await ui.confirm({ icon: 'power', title: 'Log out computer', text: `Log computer ${c.id} out of ${c.user_name}? Grape on it goes back to the welcome screen.`, ok: 'Log out' }))) return;
      try { await call('unlink', { id: c.id }); ui.toast('Logged out', 'ok'); load(); } catch (e) { ui.toast(e.message); }
    };
    return (
      <>
        <h2>Computers</h2>
        <div className="admin-tools">
          <input className="set-input" placeholder="Search ids, users..." value={find} onChange={(e) => setFind(e.target.value)} />
          <span className="grow" />
          <button className="mc-get" onClick={load}>Refresh</button>
        </div>
        {!computers ? <p className="mc-none">Loading...</p> : !shown.length ? <p className="mc-none">No computers yet.</p> : (
          <div className="mc-card set-card">
            {shown.map((c) => (
              <Row key={c.id} icon="cpu" title={<><span className={'admin-dot' + (c.online ? ' on' : '')} title={c.online ? 'Online' : 'Offline'} /><code>{c.id}</code></>}
                sub={`pc ${c.hwid || '-'}  ·  first seen ${dateOf(c.created)}${c.old_plan ? '  ·  has old ' + c.old_plan + ' time' : ''}`}>
                <b className="set-value">{c.user ? c.user_name : 'Not logged in'}</b>
                {c.user && <button className="mc-get" onClick={() => logout(c)}>Log out</button>}
              </Row>
            ))}
          </div>
        )}
      </>
    );
  }

  const shown = (list || []).filter((u) => !wanted || (u.name + ' ' + u.username + ' ' + u.id).toLowerCase().includes(wanted));
  return (
    <>
      <h2>Users</h2>
      <div className="admin-tools">
        <input className="set-input" placeholder="Search names, Discord ids..." value={find} onChange={(e) => setFind(e.target.value)} />
        <span className="grow" />
        <button className="mc-get" onClick={load}>Refresh</button>
      </div>
      {!list ? <p className="mc-none">Loading...</p> : !shown.length ? <p className="mc-none">{list.length ? 'No user matches.' : 'No users yet: one is made when someone logs in with Discord.'}</p> : (
        <div className="mc-card set-card">
          {shown.map((u) => (
            <div key={u.id}>
              <div className="set-row admin-click discord-row" role="button" tabIndex={0} aria-expanded={open === u.id}
                onClick={() => setOpen(open === u.id ? null : u.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === u.id ? null : u.id); } }}>
                <Face user={u} />
                <div className="set-words">
                  <b>{u.name}</b>
                  <span>{u.username ? '@' + u.username + '  ·  ' : ''}{u.id}  ·  last used {ago(u.last)}</span>
                </div>
                <b className={'set-value' + (u.active ? ' good' : u.plan || u.revoked ? ' bad' : '')}>{u.plan_name}  ·  {timeLeft(u)}</b>
                <Ic name={open === u.id ? 'chevron-down' : 'chevron-right'} />
              </div>
              {open === u.id && <UserDetail user={u} plans={plans} ui={ui} reload={load} />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Settings

function Field({ icon, title, sub, value, onChange, placeholder, type, locked }) {
  return (
    <Row icon={icon} title={title} sub={locked ? 'Set by the server’s environment: change it there' : sub}>
      <input className="set-input admin-wide" type={type || 'text'} value={value} placeholder={placeholder} disabled={locked} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </Row>
  );
}

function Settings({ section, plans, ui }) {
  const [discord, setDiscord] = useState(null);
  const [form, setForm] = useState({});
  const [site, setSite] = useState(null);
  const [sec, setSec] = useState(null);
  const [pw, setPw] = useState({ current: '', password: '', again: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (section === 'discord') call('discord').then((d) => { setDiscord(d); setForm({ client_id: d.client_id, client_secret: '', redirect_uri: d.redirect_uri, public_url: d.from_env.public_url ? d.public_url : d.saved_public_url }); }).catch((e) => ui.toast(e.message));
    if (section === 'website') call('site').then(setSite).catch((e) => ui.toast(e.message));
    if (section === 'security') call('security').then(setSec).catch((e) => ui.toast(e.message));
  }, [section, ui]);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const copy = async (text) => { if (await copyText(text)) ui.toast('Copied', 'ok'); else ui.toast('Could not copy: select the text and copy it yourself.'); };

  if (section === 'discord') {
    if (!discord) return <p className="mc-none">Loading...</p>;
    const save = async () => {
      setBusy(true);
      try {
        const d = await call('save-discord', form);
        setDiscord(d);
        setForm((f) => ({ ...f, client_secret: '' }));
        ui.toast(d.ready ? 'Saved: Discord login is ready' : 'Saved', 'ok');
      } catch (e) { ui.toast(e.message); }
      setBusy(false);
    };
    const redirect = form.redirect_uri || (form.public_url ? form.public_url.replace(/\/+$/, '') + '/v1/discord/callback' : discord.default_redirect);
    return (
      <>
        <h2>Discord</h2>
        <div className="mc-card set-card">
          <Row icon="discord" title="Discord Login" sub="How Grape and this website log people in">
            <b className={'set-value ' + (discord.ready ? 'good' : 'bad')}>{discord.ready ? 'Ready' : 'Not set up'}</b>
          </Row>
        </div>
        <h6>APPLICATION</h6>
        <div className="mc-card set-card">
          <Field icon="layers" title="Client ID" sub="Discord Developer Portal > your app > OAuth2" value={form.client_id || ''} onChange={set('client_id')} placeholder="123456789012345678" locked={discord.from_env.client_id} />
          <Field icon="eye-off" title="Client Secret" sub={discord.has_secret ? 'Saved. Type a new one only to replace it' : 'Discord shows it once: Reset Secret to get a new one'} type="password" value={form.client_secret || ''} onChange={set('client_secret')} placeholder={discord.has_secret ? '••••••••••••' : 'Paste the secret'} locked={discord.from_env.client_secret} />
        </div>
        <h6>ADDRESSES</h6>
        <div className="mc-card set-card">
          <Field icon="earth" title="Public Address" sub="Where browsers reach this server. Empty: this computer" value={form.public_url || ''} onChange={set('public_url')} placeholder={discord.public_url} locked={discord.from_env.public_url} />
          <Field icon="arrow-up-right" title="Redirect" sub="Empty: the public address + /v1/discord/callback" value={form.redirect_uri || ''} onChange={set('redirect_uri')} placeholder={discord.default_redirect} locked={discord.from_env.redirect_uri} />
          <Row icon="copy" title="Add This Redirect In Discord" sub={redirect}>
            <button className="mc-get" onClick={() => copy(redirect)}>Copy</button>
          </Row>
        </div>
        <div className="admin-actions"><button className="mc-get admin-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button></div>
        <p className="admin-hint">The secret never leaves this server: the app only ever gets sent to this server&apos;s own login page. The public address must be the one the app is built to talk to.</p>
      </>
    );
  }

  if (section === 'security') {
    if (!sec) return <p className="mc-none">Loading...</p>;
    const save = async () => {
      setBusy(true);
      try {
        const d = await call('save-security', sec);
        setSec({ ...d, alert_webhook: d.alert_webhook });
        ui.toast('Saved', 'ok');
      } catch (e) { ui.toast(e.message); }
      setBusy(false);
    };
    const put = (k) => (v) => setSec((s) => ({ ...s, [k]: v }));
    return (
      <>
        <h2>Security</h2>
        <h6>WHICH COPIES OF GRAPE ARE LET IN</h6>
        <div className="mc-card set-card">
          <Field icon="refresh-cw" title="Oldest Version" sub={'Older copies are told to get a new installer. Empty: any. Published: ' + (sec.version || 'unknown')} value={sec.min_version || ''} onChange={put('min_version')} placeholder="0.1.0" />
          <Row icon="check" title="Only Official Builds" sub={'Refuse a copy whose file is not the one this server gives out' + (sec.app_sha256 ? ' (' + sec.app_sha256.slice(0, 12) + '...)' : '')}>
            <Switch label="Only official builds" on={!!sec.require_build} onChange={put('require_build')} />
          </Row>
        </div>
        <p className="admin-hint">A copy tells the server its own version and file hash. That keeps out old and carelessly changed copies; it does not stop someone who patches the program on purpose. Turn on official builds only after the published Grape.exe is the one people have.</p>
        <h6>THIS PAGE</h6>
        <div className="mc-card set-card">
          <Field icon="earth" title="Allowed Addresses" sub={sec.from_env && sec.from_env.admin_ips ? 'Set by the server\'s environment' : 'IP addresses that may open this page, separated by commas. Empty: anyone who knows the address'} value={sec.admin_ips || ''} onChange={put('admin_ips')} placeholder="203.0.113.5, 198.51.100.7" locked={sec.from_env && sec.from_env.admin_ips} />
        </div>
        <h6>ALERTS</h6>
        <div className="mc-card set-card">
          <Field icon="discord" title="Discord Webhook" sub={sec.alert_webhook === 'set' ? 'Saved. Paste a new address only to replace it; empty it to remove' : 'Wrong admin passwords, admin sign-ins, too many requests, installers used'} type="password" value={sec.alert_webhook === 'set' ? '' : sec.alert_webhook || ''} onChange={put('alert_webhook')} placeholder={sec.alert_webhook === 'set' ? '••••••••••••' : 'https://discord.com/api/webhooks/...'} locked={sec.from_env && sec.from_env.alert_webhook} />
        </div>
        <div className="admin-actions"><button className="mc-get admin-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button></div>
      </>
    );
  }

  if (section === 'website') {
    if (!site) return <p className="mc-none">Loading...</p>;
    const save = async () => {
      setBusy(true);
      try { setSite(await call('save-site', site)); ui.toast('Saved', 'ok'); } catch (e) { ui.toast(e.message); }
      setBusy(false);
    };
    const price = (id) => (v) => setSite((s) => ({ ...s, prices: { ...s.prices, [id]: v } }));
    return (
      <>
        <h2>Website</h2>
        <h6>LINKS</h6>
        <div className="mc-card set-card">
          <Field icon="download" title="Download" sub="Where Download for Windows goes. Empty: the button waits" value={site.download_url} onChange={(v) => setSite((s) => ({ ...s, download_url: v }))} placeholder="https://..." />
          <Field icon="discord" title="Discord Invite" sub="The Discord buttons of the landing page" value={site.discord_url} onChange={(v) => setSite((s) => ({ ...s, discord_url: v }))} placeholder="https://discord.gg/..." />
        </div>
        <h6>PRICES</h6>
        <div className="mc-card set-card">
          {plans.map((p) => (
            <Field key={p.id} icon="layers" title={p.name} sub={(p.days === null ? 'Forever' : p.days + ' days') + '. Empty: shown without a price'} value={site.prices[p.id] || ''} onChange={price(p.id)} placeholder="$4.99" />
          ))}
        </div>
        <div className="admin-actions"><button className="mc-get admin-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button></div>
      </>
    );
  }

  const change = async () => {
    if (pw.password !== pw.again) return ui.toast('The two new passwords are not the same.');
    setBusy(true);
    try { await call('password', pw); setPw({ current: '', password: '', again: '' }); ui.toast('Password changed: every other session is signed out', 'ok'); } catch (e) { ui.toast(e.message); }
    setBusy(false);
  };
  return (
    <>
      <h2>Admin Password</h2>
      <div className="mc-card set-card">
        <Field icon="eye-off" title="Current Password" type="password" value={pw.current} onChange={(v) => setPw((p) => ({ ...p, current: v }))} />
        <Field icon="pencil" title="New Password" sub="At least 10 characters" type="password" value={pw.password} onChange={(v) => setPw((p) => ({ ...p, password: v }))} />
        <Field icon="check" title="The Same Again" type="password" value={pw.again} onChange={(v) => setPw((p) => ({ ...p, again: v }))} />
      </div>
      <div className="admin-actions"><button className="mc-get admin-primary" disabled={busy || !pw.current || !pw.password} onClick={change}>Change password</button></div>
    </>
  );
}

// ------------------------------------------------------------------ Installers

const STATES = { issued: ['Waiting', ''], claimed: ['Started', ''], used: ['Used', 'good'], revoked: ['Cancelled', 'bad'], expired: ['Expired', 'bad'] };

function Installers({ section, ui, link, setLink }) {
  const [list, setList] = useState(null);
  const [status, setStatus] = useState(null);
  const [note, setNote] = useState('');
  const [hours, setHours] = useState(72);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(null);          // installers one person may make a day from the website (0 = no limit)

  const load = useCallback(() => call('installers').then((d) => { setList(d.list); setStatus(d); }).catch((e) => ui.toast(e.message)), [ui]);
  useEffect(() => { load(); }, [section, load]);
  useEffect(() => { call('installer-settings').then((s) => setLimit(s.limit)).catch(() => {}); }, [section]);
  const saveLimit = async () => {
    try { const s = await call('save-installer-limit', { limit }); setLimit(s.limit); ui.toast('Saved', 'ok'); } catch (e) { ui.toast(e.message); }
  };
  const resetLimits = async () => {
    if (!(await ui.confirm({ icon: 'rotate-cw', title: 'Reset the counts', text: 'Everyone can make installers from the website again, as if they had made none today. The installers already made stay as they are.', ok: 'Reset' }))) return;
    try { await call('reset-installer-limits'); ui.toast('Counts reset', 'ok'); } catch (e) { ui.toast(e.message); }
  };

  const copy = async (text) => { if (await copyText(text)) ui.toast('Link copied', 'ok'); else ui.toast('Could not copy: select the link and copy it yourself.'); };
  const make = async () => {
    setBusy(true);
    try {
      const made = await call('make-installer', { note, hours });
      setLink(made);
      setNote('');
      ui.toast('Installer made', 'ok');
      load();
    } catch (e) { ui.toast(e.message); }
    setBusy(false);
  };
  const cancel = async (i) => {
    if (!(await ui.confirm({ icon: 'ban', title: 'Cancel installer', text: `Cancel this installer${i.note ? ' (' + i.note + ')' : ''}? It can no longer be downloaded or started.`, ok: 'Cancel installer', danger: true }))) return;
    try { await call('revoke-installer', { id: i.id }); ui.toast('Installer cancelled', 'ok'); load(); } catch (e) { ui.toast(e.message); }
  };
  const ready = status && status.stub && status.app;

  if (section === 'make') {
    return (
      <>
        <h2>Make Installer</h2>
        <div className="mc-card set-card">
          <Row icon="download" title="Installer" sub="payload/grape-setup.exe">
            <b className={'set-value ' + (!status ? '' : status.stub ? 'good' : 'bad')}>{!status ? 'Checking' : status.stub ? 'Ready' : 'Missing'}</b>
          </Row>
          <Row icon="layers" title="Grape" sub={status && status.app ? `payload/Grape.exe  ·  ${(status.app_size / 1048576).toFixed(1)} MB${status.version ? '  ·  version ' + status.version : ''}` : 'payload/Grape.exe'}>
            <b className={'set-value ' + (!status ? '' : status.app ? 'good' : 'bad')}>{!status ? 'Checking' : status.app ? 'Ready' : 'Missing'}</b>
          </Row>
        </div>
        <h6>THE WEBSITE'S DOWNLOAD BUTTON</h6>
        <div className="mc-card set-card">
          <Row icon="download" title="Installers Per Person Per Day" sub="How many a person can make from the download popup. 0 means no limit">
            <div className="admin-count">
              <Stepper label="Installers per day" value={limit === null ? 3 : limit} min={0} max={1000} onChange={setLimit} />
              <button className="mc-get" disabled={limit === null} onClick={saveLimit}>Save</button>
            </div>
          </Row>
          <Row icon="rotate-cw" title="Reset Today's Counts" sub="Lets everyone make installers again right now">
            <button className="mc-get" onClick={resetLimits}>Reset</button>
          </Row>
        </div>
        <h6>NEW INSTALLER</h6>
        <div className="mc-card set-card">
          <Row icon="pencil" title="Note" sub="Who it is for. Only you see it">
            <input className="set-input" value={note} maxLength={80} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
          </Row>
          <Row icon="clock" title="Good For" sub="How long it can be started. Once started, it is that computer's until it is done">
            <Choice label="Good for" value={hours} onChange={setHours} values={[[24, '1 day'], [72, '3 days'], [168, '1 week'], [720, '30 days']]} />
          </Row>
          <Row icon="sparkles" title="Make an installer" sub="One download, one computer, one install">
            <button className="mc-get admin-primary" disabled={busy || !ready} onClick={make}>{busy ? 'Making...' : 'Make installer'}</button>
          </Row>
        </div>
        {link && (
          <>
            <h6>MADE JUST NOW</h6>
            <div className="mc-card set-card">
              <Row icon="check" title={<code className="admin-key">{link.url}</code>} sub={'Good until ' + timeOf(link.expires)}>
                <button className="mc-get" onClick={() => copy(link.url)}>Copy</button>
              </Row>
            </div>
            <p className="admin-hint">Send this link to one person. It is shown only now: the server keeps just a fingerprint of it. Once they start the installer it is theirs alone, and when it finishes it can never be used again.</p>
          </>
        )}
        {!ready && status && <p className="admin-hint">Put the installer and Grape in the server&apos;s payload folder (sync-payload.ps1) to make installers.</p>}
      </>
    );
  }

  return (
    <>
      <h2>All Installers</h2>
      <div className="admin-tools"><span className="grow" /><button className="mc-get" onClick={load}>Refresh</button></div>
      {!list ? <p className="mc-none">Loading...</p> : !list.length ? <p className="mc-none">No installers yet. Make one in Make Installer.</p> : (
        <div className="mc-card set-card">
          {list.map((i) => {
            const [text, tone] = STATES[i.state] || [i.state, ''];
            const where = i.state === 'used' ? `used ${timeOf(i.used_at)} on ${i.computer}` : i.state === 'claimed' ? `started ${timeOf(i.claimed_at)} on ${i.computer} (try ${i.tries})` : i.state === 'issued' ? `good until ${timeOf(i.expires)}` : '';
            return (
              <Row key={i.id} icon={i.state === 'used' ? 'check' : i.state === 'revoked' || i.state === 'expired' ? 'ban' : 'download'}
                title={(i.note || i.id) + (i.by !== 'admin' ? '  ·  from the website' : '')}
                sub={`Made ${dateOf(i.made)}  ·  ${i.downloads} download${i.downloads === 1 ? '' : 's'}${where ? '  ·  ' + where : ''}`}>
                <b className={'set-value ' + tone}>{text}</b>
                {(i.state === 'issued' || i.state === 'claimed') && <button className="mc-get" onClick={() => cancel(i)}>Cancel</button>}
              </Row>
            );
          })}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the window

const PAGES = {
  home: { title: 'Home', icon: 'home', sections: [['overview', 'Overview', 'layers'], ['log', 'Server Log', 'file-text']] },
  keys: { title: 'Keys', icon: 'sparkles', sections: [['make', 'Make Keys', 'plus'], ['list', 'All Keys', 'layout-list']] },
  users: { title: 'Users', icon: 'earth', sections: [['users', 'Users', 'earth'], ['computers', 'Computers', 'cpu']] },
  installers: { title: 'Installers', icon: 'download', sections: [['make', 'Make Installer', 'plus'], ['list', 'All Installers', 'layout-list']] },
  settings: { title: 'Settings', icon: 'settings', sections: [['discord', 'Discord', 'discord'], ['website', 'Website', 'download'], ['security', 'Security', 'triangle-alert'], ['password', 'Admin Password', 'eye-off']] },
};

export default function AdminApp({ setup }) {
  const ui = useDialogs();
  const [auth, setAuth] = useState(null);          // {ready, authed}
  const [page, setPage] = useState('home');
  const [sections, setSections] = useState({ home: 'overview', keys: 'make', users: 'users', installers: 'make', settings: 'discord' });
  const [narrow, setNarrow] = useState(false);
  const [plans, setPlans] = useState([]);
  const [overview, setOverview] = useState(null);
  const [installerLink, setInstallerLink] = useState(null);   // the installer just made (its link is shown once)
  const [made, setMade] = useState([]);            // the keys just made: kept here, so they are still there after a look at another page
  const section = sections[page];
  const uiApi = useMemo(() => ({ toast: ui.toast, confirm: ui.confirm }), [ui.toast, ui.confirm]);

  const check = useCallback(() => call('state').then(setAuth).catch(() => setAuth({ ready: true, authed: false })), []);
  useEffect(() => { check(); }, [check]);
  useEffect(() => {
    onExpired = () => setAuth({ ready: true, authed: false });       // any call that finds the session over goes back to signing in
    return () => { onExpired = null; };
  }, []);
  useEffect(() => {
    if (!auth || !auth.authed) return undefined;
    call('plans').then(setPlans).catch(() => {});
    if (page !== 'home') return undefined;
    const load = () => call('overview').then(setOverview).catch((e) => { if (e.status === 401) check(); });
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [auth, page, check]);

  if (!auth) return null;
  if (!auth.authed) return <><SignIn ready={auth.ready} setup={setup} onIn={check} />{ui.view}</>;

  const signOut = async () => { await call('logout').catch(() => {}); setAuth({ ready: true, authed: false }); };
  const p = PAGES[page];
  return (
    <div className="admin">
      <header className="titlebar">
        <div className="titlebar-left">
          <div className="brand"><img src="/grape/logo.png" alt="" draggable={false} /><span>Grape</span></div>
          <span className="admin-badge">Admin</span>
        </div>
        <nav className="nav-tabs" aria-label="Pages">
          {Object.entries(PAGES).map(([id, pg]) => (
            <button key={id} className={page === id ? 'on' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><Ic name={pg.icon} />{pg.title}</button>
          ))}
        </nav>
        <div className="titlebar-right">
          <a className="admin-out" href="/" target="_blank" rel="noreferrer"><Ic name="arrow-up-right" />Website</a>
          <button className="admin-out" onClick={signOut}><Ic name="power" />Sign out</button>
        </div>
      </header>
      <section className={'mc-page pg' + (narrow ? ' narrow' : '')}>
        <aside className="mc-side">
          <div className="mc-side-head"><span>{p.title}</span><button className="ghost pg-collapse" aria-label="Toggle sidebar" onClick={() => setNarrow((n) => !n)}><Ic name="chevron-left" /></button></div>
          {p.sections.map(([id, text, icon]) => (
            <button key={id} className={'mc-side-item' + (section === id ? ' active' : '')} onClick={() => setSections((s) => ({ ...s, [page]: id }))}><Ic name={icon} /><span>{text}</span></button>
          ))}
        </aside>
        <div className="mc-main" key={page}>
          {page === 'home' && <Home section={section} data={overview} />}
          {page === 'keys' && <Keys section={section} plans={plans} ui={uiApi} made={made} setMade={setMade} />}
          {page === 'users' && <Users section={section} plans={plans} ui={uiApi} />}
          {page === 'installers' && <Installers section={section} ui={uiApi} link={installerLink} setLink={setInstallerLink} />}
          {page === 'settings' && <Settings section={section} plans={plans} ui={uiApi} />}
        </div>
      </section>
      {ui.view}
    </div>
  );
}
