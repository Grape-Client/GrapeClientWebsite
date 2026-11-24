// The step before Discord: "Log in to Grape on the computer that shows this code?". Without it, a login link made on
// one computer could be sent to someone else, who approves it on Discord without knowing what it is for - and the first
// computer would be logged in as them. The code on this page is the one in the Grape window that opened it.
import { redirect } from 'next/navigation';
import { grape, SiteStyle } from '../../_site/parts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Log in to Grape', robots: { index: false } };

export default async function Confirm({ searchParams }) {
  const { state } = await searchParams;
  const g = grape();
  const login = g ? g.loginOf(String(state || '')) : null;
  if (!login || login.web) redirect('/login/problem?why=expired');
  return (
    <main className="center">
      <SiteStyle />
      <div className="center-box">
        <img src="/grape/logo.png" alt="" />
        <h1>Log in to Grape</h1>
        <p>Continue only if Grape on your computer shows this code:</p>
        <div className="code" aria-label={'Code ' + login.code.split('').join(' ')}>{login.code.split('').map((c, i) => <b key={i}>{c}</b>)}</div>
        <form method="post" action="/login/discord/go">
          <input type="hidden" name="state" value={state} />
          <button className="btn main" type="submit">Continue with Discord</button>
        </form>
        <p className="bad">Did not start this yourself? Close this tab.</p>
      </div>
    </main>
  );
}
