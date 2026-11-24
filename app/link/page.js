// "Continue with website": the computer that started this login is logged in as the account this browser is already
// logged in with here - after the user says so, since a link could be sent to someone else. The code matches the one
// the app shows. Without a website login, the browser goes through Discord first.
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { grape, SiteStyle, Face } from '../_site/parts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Log in to Grape', robots: { index: false } };

export default async function Link({ searchParams }) {
  const { state } = await searchParams;
  const g = grape();
  const jar = await cookies();
  const page = g ? g.linkPage(String(state || ''), jar.get(g.COOKIES.site)?.value) : { problem: 'expired' };
  if (page.problem) redirect('/login/problem?why=' + page.problem);
  if (page.login) redirect('/login/discord?state=' + encodeURIComponent(state));
  return (
    <main className="center">
      <SiteStyle />
      <div className="center-box">
        <img src="/grape/logo.png" alt="" />
        <h1>Log in to Grape</h1>
        <p>Check that Grape shows this code:</p>
        <div className="code" aria-label={'Code ' + page.code.split('').join(' ')}>{page.code.split('').map((c, i) => <b key={i}>{c}</b>)}</div>
        <span className="account"><Face user={page} />{page.name}</span>
        <form method="post" action="/link/confirm">
          <input type="hidden" name="state" value={state} />
          <button className="btn main" type="submit">Continue as {page.name}</button>
        </form>
        <form method="post" action="/login/discord/go">
          <input type="hidden" name="state" value={state} />
          <button className="text-link" type="submit">Use another Discord account</button>
        </form>
      </div>
    </main>
  );
}
