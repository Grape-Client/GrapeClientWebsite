import { SiteStyle } from '../../_site/parts';

export const metadata = { title: 'Grape login', robots: { index: false } };

const WHY = {
  expired: ['This login link has expired', 'Start the login again from Grape: Continue with Discord on the welcome screen.'],
  cancelled: ['Login cancelled', 'Nothing was changed. You can close this tab, or start again from Grape.'],
  failed: ['Discord did not confirm the login', 'Start it again from Grape. If it keeps happening, the server’s Discord settings may be wrong.'],
  unset: ['Discord login is not set up yet', 'The server has no Discord application configured. Ask the owner, or set it on the admin page.'],
  busy: ['Too many tries', 'Wait a minute, then start the login again from Grape.'],
};

export default async function Problem({ searchParams }) {
  const { why } = await searchParams;
  // a name from the address bar: only the ones listed (not "constructor" or "toString", which every object has)
  const [title, text] = Object.hasOwn(WHY, why) ? WHY[why] : WHY.expired;
  return (
    <main className="center">
      <SiteStyle />
      <div className="center-box">
        <img src="/grape/logo.png" alt="" />
        <h1>{title}</h1>
        <p>{text}</p>
        <a className="text-link" href="/">Grape&apos;s website</a>
      </div>
    </main>
  );
}
