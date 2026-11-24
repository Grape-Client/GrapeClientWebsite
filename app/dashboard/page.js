// The account's dashboard: what this Discord account has - its plan and time, its computers, what it paid and redeemed,
// and how much it used Grape. Only for the account the browser is logged in with; anyone else is sent to log in.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SiteStyle } from '../_site/parts';
import Dashboard from './Dashboard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Your account | Grape', robots: { index: false } };

export default async function DashboardPage() {
  const g = globalThis.grape;
  const jar = await cookies();
  const data = g ? g.siteDashboard(jar.get(g.COOKIES.site)?.value) : null;
  if (!data) redirect('/login/discord?back=/dashboard');
  return (
    <>
      <SiteStyle />
      <Dashboard data={data} />
    </>
  );
}
