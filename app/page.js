// Grape's landing page. Everything it says is something Grape does; the windows on it are Grape itself - its own markup
// and stylesheets as the app drew them (public/site/live), not pictures.
// Prices, the download link and the Discord invite come from the admin page (Settings > Website).
import { grape, Ic, SiteStyle, Face, siteUser } from './_site/parts';
import LiveWindow from './_site/LiveWindow';

export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    shot: 'check', alt: 'The Java compiler pointing at a mistake in Problems',
    title: 'An editor that knows Java.',
    text: 'Grape’s editor is the one inside Visual Studio Code. The Java compiler checks your script while you type, against the jars of the game it is for, and Problems points at every line it does not like.',
    chips: [['triangle-alert', 'Compiler checks'], ['code', 'Autocomplete'], ['layout-list', 'Folding'], ['file-down', 'Auto save']],
  },
  {
    shot: 'minecraft', alt: 'The Minecraft page with Lunar Client, Dawn and Modrinth App versions', flip: true,
    title: 'Launch it, then inject.',
    text: 'Install Lunar Client, the Modrinth App or Dawn and launch any of their versions from Grape. Then pick the running game from Clients and press Inject: Grape gets in with its own injector, or with the DLL when a client needs it.',
    chips: [['block', 'Lunar, Modrinth, Dawn'], ['syringe', 'Two ways in'], ['square-terminal', 'Game output'], ['rotate-cw', 'Auto-Execute']],
  },
  {
    shot: 'mods', alt: 'Grape’s Modrinth browser with Fabric mods',
    title: 'Every Fabric mod, a click away.',
    text: 'Browse Modrinth from inside Grape, for the Minecraft version you play. Add a mod and Grape adds what it needs with it, then loads it into the game you are in.',
    chips: [['package', 'Modrinth browser'], ['layers', 'Dependencies added'], ['search', 'Search by version'], ['download', 'One click to add']],
  },
  {
    shot: 'mcp', alt: 'Grape MCP in Settings', flip: true,
    title: 'Let your AI write the script.',
    text: 'Grape MCP connects Claude, Cursor or VS Code to Grape. They read the script guide, save scripts and have them checked by the compiler, and run them only if you allow it.',
    chips: [['sparkles', 'Claude and Cursor'], ['check', 'Permissions you set'], ['unplug', 'Stays on your PC'], ['book-open', 'Script guide included']],
  },
];

const PERKS = [['layers', 'Every Grape feature'], ['cpu', 'One computer, movable once a day'], ['discord', 'Logged in with Discord'], ['history', 'Time left is kept']];

export default async function Landing() {
  const g = grape();
  const site = g ? g.site() : { prices: {}, discord_url: '', download_url: '' };
  const plans = g ? g.ops.plans() : [];
  const user = await siteUser();
  const length = (p) => (p.days === null ? 'Forever' : p.days === 1 ? '24 hours' : p.days + ' days');
  const buy = site.discord_url || '#download';

  return (
    <>
      <SiteStyle />
      <header className="nav">
        <div className="nav-in">
          <a className="brand" href="/"><img src="/grape/logo.png" alt="" />Grape</a>
          <nav className="nav-links" aria-label="Sections">
            <a href="#features">Features</a>
            <a href="#plans">Plans</a>
            <a href="#download">Download</a>
            {site.discord_url && <a href={site.discord_url} rel="noreferrer">Discord</a>}
          </nav>
          <span className="grow" />
          {user ? (
            <div className="who"><Face user={user} />{user.name}<a className="out" href="/logout">Log out</a></div>
          ) : (
            <a className="login-link" href="/login/discord?back=/"><Ic name="discord" />Log in</a>
          )}
        </div>
      </header>

      <main>
        <section className="hero" id="download">
          <h1>Script Minecraft in real Java.</h1>
          <p className="lead">Grape is a desktop editor that compiles your scripts against the game you are playing and runs them inside it. Clients, versions and mods live in the same window.</p>
          <div className="ctas">
            <a className="btn main" href="/download" aria-disabled={!site.download_ready}><Ic name="download" />{site.download_ready ? 'Download for Windows' : 'Download coming soon'}</a>
            <a className="btn quiet" href="#plans">See plans</a>
          </div>
          <p className="small">For Windows 10 and 11. You log in with Discord.</p>
          <div className="shot"><LiveWindow view="editor" title="Grape with a script open in the editor" /></div>
        </section>
        <div className="hero-fade" />

        <section className="features" id="features" aria-label="What Grape does">
          {FEATURES.map((f) => (
            <article className={'feature' + (f.flip ? ' flip' : '')} key={f.shot}>
              <div className="feature-shot"><LiveWindow view={f.shot} title={f.alt} /></div>
              <div>
                <h2>{f.title}</h2>
                <p>{f.text}</p>
                <div className="chips">{f.chips.map(([icon, text]) => <span className="chip" key={text}><Ic name={icon} />{text}</span>)}</div>
              </div>
            </article>
          ))}
        </section>

        <section className="plans" id="plans">
          <h2>Pick your time.</h2>
          <p className="lead">Every plan is all of Grape: they differ only in how long. A key adds its time to your Discord account.</p>
          <ul className="perks">{PERKS.map(([icon, t]) => <li key={t}><Ic name={icon} />{t}</li>)}</ul>
          <div className="plan-grid">
            {plans.map((p) => (
              <div className={'plan' + (p.id === 'month' ? ' pick' : '')} key={p.id}>
                <span className="name">{p.name}</span>
                <span className="price">{site.prices[p.id] || length(p)}</span>
                <span className="length">{site.prices[p.id] ? length(p) : p.days === null ? 'No end date' : 'Of full access'}</span>
                <a className={'btn ' + (p.id === 'month' ? 'main' : 'quiet')} href={buy} rel="noreferrer">Get a key</a>
              </div>
            ))}
          </div>
          <p className="note">Keys, not a subscription: nothing renews by itself. Redeem a key in Grape after you log in.</p>
        </section>

        <section className="cta">
          <h2>Your next script is one window away.</h2>
          <p>Download Grape, log in with Discord, and write.</p>
          <a className="btn main" href="/download" aria-disabled={!site.download_ready}><Ic name="download" />{site.download_ready ? 'Download for Windows' : 'Download coming soon'}</a>
        </section>
      </main>

      <footer className="foot">
        <div className="foot-in">
          <div className="about">
            <a className="brand" href="/"><img src="/grape/logo.png" alt="" />Grape</a>
            <p>Java scripts for Minecraft, written, checked and run from one window.</p>
          </div>
          <div><h3>Grape</h3><ul><li><a href="#download">Download</a></li><li><a href="#features">Features</a></li><li><a href="#plans">Plans</a></li></ul></div>
          <div><h3>Account</h3><ul>{user ? <><li><a href="/logout">Log out</a></li></> : <li><a href="/login/discord?back=/">Log in with Discord</a></li>}</ul></div>
          {site.discord_url && <div><h3>Community</h3><ul><li><a href={site.discord_url} rel="noreferrer">Discord</a></li></ul></div>}
        </div>
        <div className="foot-base"><span>&copy; {new Date().getFullYear()} Grape</span><span>Not affiliated with Mojang or Microsoft.</span></div>
      </footer>
    </>
  );
}
