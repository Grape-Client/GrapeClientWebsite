// Small pieces of the website shared by its pages. The server's core (lib/core.js) is reached through globalThis.grape:
// server.js puts the running instance there, with its logins and settings.
import { cookies } from 'next/headers';

export const grape = () => globalThis.grape;
export const Ic = ({ name }) => <i className="ic" style={{ '--i': `url(/grape/icons/${name}.svg)` }} />;
export const SiteStyle = () => <link rel="stylesheet" href="/site/site.css" precedence="site" />;

/** The Windows mark, one colour (it takes the colour of the text around it). */
export const WindowsLogo = () => (
  <svg className="winlogo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M3 5.6 10.4 4.6v6.9H3zM11.6 4.4 21 3v8.5h-9.4zM3 12.5h7.4v6.9L3 18.4zM11.6 12.5H21V21l-9.4-1.3z" fill="currentColor" />
  </svg>
);

/** The account this browser is logged in with on the website, or null. */
export async function siteUser() {
  const g = grape();
  if (!g) return null;
  const jar = await cookies();
  return g.siteUser(jar.get(g.COOKIES.site)?.value);
}

export function Face({ user, size }) {
  return (
    <span className="face" style={size ? { width: size, height: size } : undefined}>
      {user.avatar ? <img src={user.avatar} alt="" /> : user.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The bar on top of every page: sticky, the links on the left, the person (or the way in) on the right. */
export function Nav({ user, site, ready }) {
  return (
    <header className="nav">
      <div className="nav-in">
        <a className="brand" href="/"><img src="/grape/logo.png" alt="" />Grape</a>
        <nav className="nav-links" aria-label="Sections">
          <a href="/#features">Features</a>
          <a href="/#plans">Plans</a>
          <a href="/install">Download</a>
          <a href="/#faq">Questions</a>
          {site.discord_url && <a href={site.discord_url} rel="noreferrer">Discord</a>}
        </nav>
        <span className="grow" />
        {user ? (
          <div className="who"><Face user={user} />{user.name}<a className="out" href="/logout">Log out</a></div>
        ) : (
          <a className="pill dark" href="/login/discord?back=/"><Ic name="discord" />Log in</a>
        )}
        <a className="pill light" href="/install" aria-disabled={!ready}>Download</a>
      </div>
    </header>
  );
}

export function Foot({ user, site }) {
  return (
    <footer className="foot">
      <div className="foot-in">
        <div className="about">
          <a className="brand" href="/"><img src="/grape/logo.png" alt="" />Grape</a>
          <p>Java scripts for Minecraft, written, checked and run from one window.</p>
        </div>
        <div><h3>Grape</h3><ul><li><a href="/install">Download</a></li><li><a href="/#features">Features</a></li><li><a href="/#plans">Plans</a></li><li><a href="/#faq">Questions</a></li></ul></div>
        <div><h3>Account</h3><ul>{user ? <li><a href="/logout">Log out</a></li> : <li><a href="/login/discord?back=/">Log in with Discord</a></li>}</ul></div>
        <div><h3>Legal</h3><ul><li><a href="/terms">Terms of Service</a></li>{site.discord_url && <li><a href={site.discord_url} rel="noreferrer">Discord</a></li>}</ul></div>
      </div>
      <div className="foot-base"><span>&copy; {new Date().getFullYear()} Grape</span><span>Not affiliated with Mojang or Microsoft.</span></div>
    </footer>
  );
}
