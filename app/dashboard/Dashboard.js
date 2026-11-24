'use client';
// The dashboard's sections and the activity of the last year. The data comes from the page (lib/core.js siteDashboard).
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BuyModal } from '../_site/BuyModal';
import { DownloadModal } from '../_site/DownloadModal';

const Ic = ({ name }) => <i className="ic" style={{ '--i': `url(/grape/icons/${name}.svg)` }} />;
const SECTIONS = [['overview', 'Overview', 'home'], ['subscription', 'Subscription', 'sparkles'], ['devices', 'Devices', 'cpu'], ['payments', 'Payments', 'zap'], ['history', 'Key History', 'history']];
const DAY = 86400000;

const dateOf = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-');
const timeOf = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
function span(ms) {
  if (ms <= 0) return '0m';
  const d = Math.floor(ms / DAY), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const STATUS = { waiting: 'Waiting', seen: 'Seen', partial: 'Underpaid', crediting: 'Adding time', paid: 'Paid', expired: 'Expired', error: 'Needs help' };

function Face({ user, size }) {
  return <span className="dash-face" style={{ width: size, height: size }}>{user.avatar ? <img src={user.avatar} alt="" /> : user.name.slice(0, 1).toUpperCase()}</span>;
}

/** The last 53 weeks, one square a day, Sunday at the top: Daily (each day), Weekly (each week), Cumulative (the running total). */
function Activity({ activity }) {
  const [mode, setMode] = useState('daily');
  const { weeks, months, total } = useMemo(() => {
    // in UTC days, as the server counts them
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(today.getTime() - (52 * 7 + today.getUTCDay()) * DAY);
    const cols = [];
    let running = 0, sum = 0;
    for (let w = 0; w < 53; w++) {
      const days = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start.getTime() + (w * 7 + d) * DAY);
        const future = date > today;
        const count = future ? 0 : activity[date.toISOString().slice(0, 10)] || 0;
        running += count;
        sum += count;
        days.push({ date, count, running, future });
      }
      cols.push(days);
    }
    const labels = [];
    cols.forEach((days, i) => {
      const first = days.find((d) => d.date.getUTCDate() <= 7);
      if (first && (!labels.length || labels[labels.length - 1].i < i - 2)) labels.push({ i, text: first.date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) });
    });
    return { weeks: cols, months: labels, total: sum };
  }, [activity]);

  const value = (week, day) => (mode === 'daily' ? day.count : mode === 'weekly' ? week.reduce((a, d) => a + d.count, 0) : day.running);
  const max = Math.max(1, ...weeks.flatMap((w) => w.map((d) => (d.future ? 0 : value(w, d)))));
  const level = (v) => (v <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999)));
  const label = (week, day) => {
    const when = day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const v = value(week, day);
    return mode === 'daily' ? `${v} use${v === 1 ? '' : 's'} on ${when}` : mode === 'weekly' ? `${v} use${v === 1 ? '' : 's'} in the week of ${when}` : `${v} use${v === 1 ? '' : 's'} by ${when}`;
  };

  return (
    <section className="dash-activity">
      <div className="dash-activity-head">
        <div><h3>Activity</h3><p>{total ? `${total} use${total === 1 ? '' : 's'} of Grape in the last year.` : 'Your Grape use over the last year. It fills in as you inject and run scripts.'}</p></div>
        <div className="dash-modes" role="group" aria-label="Show">
          {[['daily', 'Daily'], ['weekly', 'Weekly'], ['cumulative', 'Cumulative']].map(([id, text]) => (
            <button key={id} className={mode === id ? 'on' : ''} aria-pressed={mode === id} onClick={() => setMode(id)}>{text}</button>
          ))}
        </div>
      </div>
      <div className="dash-heat-scroll">
        <div className="dash-heat" role="img" aria-label={`Activity of the last year: ${total} uses`}>
          {weeks.map((week, i) => (
            <div className="dash-week" key={i}>
              {week.map((day, j) => <span key={j} className={'dash-cell l' + (day.future ? 'x' : level(value(week, day)))} title={day.future ? '' : label(week, day)} />)}
            </div>
          ))}
        </div>
        <div className="dash-months" aria-hidden="true">
          {months.map((m) => <span key={m.i} style={{ left: `calc(${m.i} * var(--cell-step))` }}>{m.text}</span>)}
        </div>
      </div>
    </section>
  );
}

function Redeem({ onDone }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState(['', '']);
  const shape = (t) => (t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 25).match(/.{1,5}/g) || []).join('-');
  const redeem = async (e) => {
    e.preventDefault();
    setBusy(true);
    setSay(['', '']);
    try {
      const r = await fetch('/api/installer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'redeem', code: key }) });
      const j = await r.json().catch(() => ({ error: 'The server did not answer.' }));
      if (!r.ok) setSay([j.error || 'That did not work.', 'bad']);
      else { setKey(''); setSay(['Redeemed: the time is on your account.', 'good']); onDone(); }
    } catch { setSay(['Could not reach the server.', 'bad']); }
    setBusy(false);
  };
  return (
    <form className="dash-redeem" onSubmit={redeem}>
      <input value={key} onChange={(e) => setKey(shape(e.target.value))} placeholder="GRAPE-XXXXX-XXXXX-XXXXX-XXXXX" maxLength={29} spellCheck="false" autoComplete="off" aria-label="License key" />
      <button className="btn main" disabled={busy || key.replace(/-/g, '').length < 25}>{busy ? 'Redeeming...' : 'Redeem'}</button>
      {say[0] && <p className={'dash-say ' + say[1]}>{say[0]}</p>}
    </form>
  );
}

export default function Dashboard({ data }) {
  const [section, setSection] = useState('overview');
  const router = useRouter();
  const left = data.expires === null ? Infinity : data.expires - data.now;
  const timeLeft = data.revoked ? 'Switched off' : !data.plan ? 'None' : data.expires === null ? 'Forever' : left > 0 ? span(left) : 'Expired';
  const buy = (plan) => window.dispatchEvent(new CustomEvent('grape-buy', { detail: { plan } }));
  const download = () => window.dispatchEvent(new CustomEvent('grape-download'));
  const canReset = data.locked && data.now >= data.reset_after;

  const cards = [
    [dateOf(data.created), 'Member since'],
    [data.active || data.expires === null ? data.plan_name : data.plan ? data.plan_name + ' (ended)' : 'None', 'Current plan'],
    [timeLeft, 'Time on account'],
    [String(data.uses), 'Times used'],
    [String(data.computers.length), data.computers.length === 1 ? 'Computer' : 'Computers'],
  ];

  return (
    <div className="dash">
      <header className="dash-top">
        <a className="brand" href="/"><img src="/grape/logo.png" alt="" />Grape Account</a>
        <span className="grow" />
        <button className="pill dark" onClick={download}>Download</button>
        <a className="pill light" href="/logout">Sign out</a>
      </header>

      <div className="dash-body">
        <aside className="dash-side">
          <div className="dash-who"><Face user={data} size={44} /><div><b>{data.name}</b><span>@{data.username || data.id}</span></div></div>
          <nav aria-label="Account">
            {SECTIONS.map(([id, text, icon]) => (
              <button key={id} className={section === id ? 'on' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}><Ic name={icon} />{text}</button>
            ))}
          </nav>
        </aside>

        <main className="dash-main">
          {section === 'overview' && (
            <>
              <div className="dash-hero"><Face user={data} size={96} /><div><h1>{data.name}</h1><p>@{data.username || data.id}</p></div></div>
              <div className="dash-cards">{cards.map(([big, small]) => <div className="dash-card" key={small}><b>{big}</b><span>{small}</span></div>)}</div>
              <Activity activity={data.activity} />
            </>
          )}

          {section === 'subscription' && (
            <>
              <h2>Subscription</h2>
              <div className="dash-panel">
                <div className="dash-line"><span>Plan</span><b>{data.plan_name}</b></div>
                <div className="dash-line"><span>Status</span><b className={data.active ? 'good' : 'bad'}>{data.revoked ? 'Switched off' : data.active ? 'Active' : data.plan ? 'Expired' : 'No plan'}</b></div>
                <div className="dash-line"><span>Time left</span><b>{timeLeft}</b></div>
                <div className="dash-line"><span>Valid until</span><b>{data.expires === null ? 'Never ends' : data.expires ? dateOf(data.expires) : '-'}</b></div>
              </div>
              <div className="dash-actions">
                <button className="btn main" onClick={() => buy('month')}>Buy time</button>
                {data.active && <button className="btn quiet" onClick={download}>Download Grape</button>}
              </div>
              <h3 className="dash-sub">Redeem a key</h3>
              <p className="dash-note">A key adds its time to this account. Each key works once.</p>
              <Redeem onDone={() => router.refresh()} />
            </>
          )}

          {section === 'devices' && (
            <>
              <h2>Devices</h2>
              <div className="dash-panel">
                <div className="dash-line"><span>Locked to a computer</span><b>{data.locked ? 'Yes, since ' + dateOf(data.hwid_set_at) : 'Not yet'}</b></div>
                <div className="dash-line"><span>Move it to another computer</span><b className={canReset || !data.locked ? 'good' : ''}>{!data.locked ? 'The first computer you use takes it' : canReset ? 'Possible now, in Grape' : 'From ' + timeOf(data.reset_after)}</b></div>
              </div>
              <p className="dash-note">Your account works on one computer at a time. To move it, open Grape on the new computer and choose Use it on this computer (once every 24 hours).</p>
              <h3 className="dash-sub">Computers logged in</h3>
              {data.computers.length ? (
                <div className="dash-panel">
                  {data.computers.map((c) => <div className="dash-line" key={c.id}><span><Ic name="cpu" />Computer {c.id}</span><b>{c.locked ? 'This account is locked to it' : 'Since ' + dateOf(c.created)}</b></div>)}
                </div>
              ) : <p className="dash-note">No computer is logged in yet. Download Grape and log in with Discord.</p>}
            </>
          )}

          {section === 'payments' && (
            <>
              <h2>Payments</h2>
              {data.orders.length ? (
                <div className="dash-panel">
                  {data.orders.map((o) => (
                    <div className="dash-line" key={o.id}>
                      <span>{o.plan_name}  ·  {o.amount} {o.symbol}  ·  {dateOf(o.created)}</span>
                      <b className={o.status === 'paid' ? 'good' : ['partial', 'error'].includes(o.status) ? 'bad' : ''}>{STATUS[o.status] || o.status} <a href={o.explorer} target="_blank" rel="noreferrer" aria-label="View on the blockchain"><Ic name="arrow-up-right" /></a></b>
                    </div>
                  ))}
                </div>
              ) : <p className="dash-note">No payments yet.</p>}
              <div className="dash-actions"><button className="btn main" onClick={() => buy('month')}>Buy time</button></div>
            </>
          )}

          {section === 'history' && (
            <>
              <h2>Key History</h2>
              <p className="dash-note">Every time added to this account: keys you redeemed and plans you paid for.</p>
              {data.history.length ? (
                <div className="dash-panel">
                  {data.history.map((h, i) => <div className="dash-line" key={i}><span><Ic name="sparkles" />{h.plan_name}</span><b>{timeOf(h.at)}</b></div>)}
                </div>
              ) : <p className="dash-note">Nothing yet.</p>}
            </>
          )}
        </main>
      </div>
      <DownloadModal />
      <BuyModal />
    </div>
  );
}
