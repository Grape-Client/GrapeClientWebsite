// Small pieces of the website shared by its pages. The server's core (lib/core.js) is reached through globalThis.grape:
// server.js puts the running instance there, with its logins and settings.
import { cookies } from 'next/headers';

export const grape = () => globalThis.grape;
export const Ic = ({ name }) => <i className="ic" style={{ '--i': `url(/grape/icons/${name}.svg)` }} />;
export const SiteStyle = () => <link rel="stylesheet" href="/site/site.css" precedence="site" />;

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
