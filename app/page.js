// Grape's landing page. Everything it says is something Grape does; the windows on it are Grape itself - its own markup
// and stylesheets as the app drew them (public/site/live), not pictures.
// Prices, the download link and the Discord invite come from the admin page (Settings > Website).
import { grape, Ic, SiteStyle, siteUser, Nav, Foot } from './_site/parts';
import LiveWindow from './_site/LiveWindow';
import { DownloadButton } from './_site/DownloadModal';

export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    shot: 'check', tone: 'violet', alt: 'The Java compiler pointing at a mistake in Problems',
    title: 'An editor that knows Java.',
    text: 'Grape’s editor is the one inside Visual Studio Code. The Java compiler checks your script while you type, against the jars of the game it is for, and Problems points at every line it does not like.',
    chips: [['triangle-alert', 'Compiler checks'], ['code', 'Autocomplete'], ['layout-list', 'Folding'], ['file-down', 'Auto save']],
  },
  {
    shot: 'minecraft', tone: 'teal', alt: 'The Minecraft page with Lunar Client, Dawn and Modrinth App versions', flip: true,
    title: 'Launch it, then inject.',
    text: 'Install Lunar Client, the Modrinth App or Dawn and launch any of their versions from Grape. Then pick the running game from Clients and press Inject: Grape gets in with its own injector, or with the DLL when a client needs it.',
    chips: [['block', 'Lunar, Modrinth, Dawn'], ['syringe', 'Two ways in'], ['square-terminal', 'Game output'], ['rotate-cw', 'Auto-Execute']],
  },
  {
    shot: 'mods', tone: 'amber', alt: 'Grape’s Modrinth browser with Fabric mods',
    title: 'Every Fabric mod, a click away.',
    text: 'Browse Modrinth from inside Grape, for the Minecraft version you play. Add a mod and Grape adds what it needs with it, then loads it into the game you are in.',
    chips: [['package', 'Modrinth browser'], ['layers', 'Dependencies added'], ['search', 'Search by version'], ['download', 'One click to add']],
  },
  {
    shot: 'mcp', tone: 'blue', alt: 'Grape MCP in Settings', flip: true,
    title: 'Let your AI write the script.',
    text: 'Grape MCP connects Claude, Cursor or VS Code to Grape. They read the script guide, save scripts and have them checked by the compiler, and run them only if you allow it.',
    chips: [['sparkles', 'Claude and Cursor'], ['check', 'Permissions you set'], ['unplug', 'Stays on your PC'], ['book-open', 'Script guide included']],
  },
];

// what is true of Grape, in numbers and words that can be checked
const FACTS = [['1.8.9 to 1.21.11', 'Minecraft versions'], ['2', 'Ways to inject'], ['1', 'Computer per account'], ['24 h', 'To move it to another']];

const PERKS = [['layers', 'Every Grape feature'], ['cpu', 'One computer, movable once a day'], ['discord', 'Logged in with Discord'], ['history', 'Time left is kept']];

const FAQ = [
  ['How do I get Grape?', 'Press Download for Windows and log in with Discord. The server makes an installer for you: it works once, on the first computer that starts it, downloads Grape, checks it, puts it in place and removes itself.'],
  ['Can I use my account on two computers?', 'One at a time. Your account is tied to the computer you log in on, and you can move it to another one every 24 hours, from the welcome screen or Settings > Account.'],
  ['How do keys work?', 'A key adds its time to your Discord account, and each key can be used once. Nothing renews by itself: when the time ends, you redeem another key.'],
  ['What happens when my time ends?', 'Grape goes back to its welcome screen, and the rest of the program stays locked until you redeem a key. The time you have left is always kept.'],
  ['Windows says it protected my PC.', 'The installer is not code-signed yet, so SmartScreen may warn about it. If you downloaded it from this site, choose More info, then Run anyway.'],
  ['Is Grape made by Mojang or Microsoft?', 'No. Grape is independent and is not affiliated with Mojang, Microsoft or the launchers it works with.'],
];

export default async function Landing() {
  const g = grape();
  const site = g ? g.site() : { prices: {}, discord_url: '', download_url: '', download_ready: false };
  const plans = g ? g.ops.plans() : [];
  const user = await siteUser();
  const length = (p) => (p.days === null ? 'Forever' : p.days === 1 ? '24 hours' : p.days + ' days');
  const buy = site.discord_url || '/install';
  const ready = !!site.download_ready;

  return (
    <>
      <SiteStyle />
      <Nav user={user} site={site} ready={ready} />

      <main>
        <section className="hero">
          <h1>Script Minecraft in real Java.</h1>
          <p className="lead">Grape is a desktop editor that compiles your scripts against the game you are playing and runs them inside it. Clients, versions and mods live in the same window.</p>
          <div className="ctas">
            <DownloadButton className="btn main" disabled={!ready}>{ready ? 'Download for Windows' : 'Download coming soon'}</DownloadButton>
            <a className="btn quiet" href="#plans">See plans</a>
          </div>
          <p className="small">For Windows 10 and 11. You log in with Discord. Using Grape means you agree to the <a href="/terms">Terms of Service</a>.</p>
          <div className="shot"><LiveWindow view="editor" title="Grape with a script open in the editor" /></div>
        </section>

        <section className="facts" aria-label="Grape in numbers">
          {FACTS.map(([big, small]) => <div key={small}><b>{big}</b><span>{small}</span></div>)}
        </section>

        <section className="features" id="features" aria-label="What Grape does">
          {FEATURES.map((f) => (
            <article className={'feature' + (f.flip ? ' flip' : '')} key={f.shot}>
              <div className={'frame ' + f.tone}><div className="frame-in"><LiveWindow view={f.shot} title={f.alt} /></div></div>
              <div className="words">
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

        <section className="faq" id="faq">
          <h2>Questions, answered.</h2>
          <div className="faq-list">
            {FAQ.map(([q, a]) => (
              <details key={q}><summary>{q}</summary><p>{a}</p></details>
            ))}
          </div>
        </section>

        <section className="cta">
          <h2>Ready to write your first script?</h2>
          <p>Download Grape, log in with Discord, and start.</p>
          <div className="ctas">
            <DownloadButton className="btn main" disabled={!ready}>{ready ? 'Download for Windows' : 'Download coming soon'}</DownloadButton>
            {site.discord_url && <a className="btn quiet" href={site.discord_url} rel="noreferrer"><Ic name="discord" />Join the Discord</a>}
          </div>
        </section>
      </main>

      <Foot user={user} site={site} />
    </>
  );
}
