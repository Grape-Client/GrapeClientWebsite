// The download page: what you get, how the installer works, and what to do when Windows or the installer says no.
import { grape, Ic, SiteStyle, siteUser, Nav, Foot, WindowsLogo } from '../_site/parts';
import LiveWindow from '../_site/LiveWindow';
import { DownloadButton } from '../_site/DownloadModal';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Download Grape for Windows',
  description: 'Download Grape for Windows: log in with Discord, get your installer, and start scripting Minecraft in Java.',
};

const STEPS = [
  ['Log in with Discord', 'The download button opens a window that takes you to Discord and back. Grape only gets your public profile: your name, picture and id.'],
  ['Get your installer', 'The server makes an installer just for you. It works once, on the first computer that starts it, so keep it to yourself. There is a limit of a few a day.'],
  ['Run it', 'Grape is put in its own folder, with a Desktop and a Start menu shortcut if you leave them on. The installer checks what it downloaded, adds Grape to Windows’ list of apps, and removes itself when it is done.'],
  ['Open Grape', 'Log in with Discord, redeem your key, and the window opens. The first start needs the internet: the server checks your account and unlocks the window.'],
];

const NEEDS = [['cpu', 'Windows 10 or 11, 64-bit'], ['earth', 'An internet connection when Grape starts'], ['discord', 'A Discord account'], ['download', 'About 11 MB of disk space']];

const TROUBLE = [
  ['Windows says it protected my PC', 'The installer is not code-signed yet, so SmartScreen may warn about a file it has not seen often. If you downloaded it from this page, choose More info, then Run anyway.'],
  ['The installer says it was already used', 'Each installer works once. Press the download button again for a new one (there is a limit per day).'],
  ['The installer cannot reach the server', 'Check your internet connection and the clock of your computer, then run the installer again: it can be started again on the same computer until it has finished.'],
  ['My antivirus removed the file', 'Restore it from the antivirus’ quarantine, or add Grape’s folder to its exceptions. A program that talks to games is sometimes flagged by mistake.'],
  ['How do I uninstall Grape?', 'Settings > Apps > Installed apps > Grape > Uninstall. Your scripts and settings are kept.'],
];

export default async function Install() {
  const g = grape();
  const site = g ? g.site() : { discord_url: '', download_ready: false };
  const have = g ? g.ops.installerStatus() : { app_size: 0, version: '' };
  const user = await siteUser();
  const ready = !!site.download_ready;
  const size = have.app_size ? (have.app_size / 1048576).toFixed(1) + ' MB' : '';

  return (
    <>
      <SiteStyle />
      <Nav user={user} site={site} ready={ready} />

      <main>
        <section className="dl">
          <div className="frame violet"><div className="frame-in"><LiveWindow view="editor" title="Grape with a script open in the editor" /></div></div>
          <div className="dl-words">
            <p className="kicker">Windows app</p>
            <h1>Download Grape for Windows</h1>
            <p className="lead">Install Grape once and keep your scripts, clients and mods in one window. Your account is checked by Discord, and your installer is made for you.</p>
            {(have.version || size) && <p className="meta">{[have.version && 'Version ' + have.version, size].filter(Boolean).join('  ·  ')}</p>}
            <div className="ctas">
              <DownloadButton className="btn main" disabled={!ready}><WindowsLogo />{ready ? 'Download for Windows' : 'Download coming soon'}</DownloadButton>
              <a className="textlink" href="#how">Installation guide<span aria-hidden="true"> &rsaquo;</span></a>
            </div>
            <p className="small">By downloading Grape you agree to the <a href="/terms">Terms of Service</a>.</p>
          </div>
        </section>

        <section className="how" id="how">
          <h2>How the install works</h2>
          <ol className="steps">
            {STEPS.map(([title, text], i) => (
              <li key={title}><span className="n">{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>
            ))}
          </ol>
        </section>

        <section className="needs">
          <h2>What you need</h2>
          <ul className="chips wide">{NEEDS.map(([icon, text]) => <li className="chip" key={text}><Ic name={icon} />{text}</li>)}</ul>
        </section>

        <section className="faq" id="help">
          <h2>If something goes wrong</h2>
          <div className="faq-list">
            {TROUBLE.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
          </div>
          {site.discord_url && <p className="note">Still stuck? Ask in <a href={site.discord_url} rel="noreferrer">our Discord</a>.</p>}
        </section>
      </main>

      <Foot user={user} site={site} />
    </>
  );
}
