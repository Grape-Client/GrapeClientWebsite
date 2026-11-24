// Grape's Terms of Service. A page of plain text: every section is a heading and some paragraphs.
// Change the date below when the terms change.
import { grape, SiteStyle, siteUser, Nav, Foot } from '../_site/parts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Terms of Service | Grape', description: 'The terms for using Grape and grapeclient.com.' };

const UPDATED = 'November 25, 2026';

const SECTIONS = [
  ['The agreement', [
    'These terms are the agreement between you and Grape (“we”, “us”) for the Grape program for Windows (the “Software”) and this website (the “Service”). By downloading, installing or using Grape, or by logging in on this website, you agree to them. If you do not agree, do not use Grape.',
    'You must be at least 13 years old, or old enough to use Discord where you live, whichever is higher. If you are under the age of adulthood where you live, a parent or guardian must agree to these terms for you.',
  ]],
  ['What you get', [
    'We give you a personal, non-exclusive, non-transferable, revocable license to install Grape and use it on one computer at a time, for as long as your account has time on it. Grape is ours (or our licensors’). You do not buy it, you license it.',
    'The scripts you write are yours. We claim no rights to them.',
  ]],
  ['Your account', [
    'You log in with Discord. We keep your Discord id, username, display name and the address of your profile picture, so we know who you are and what time you have.',
    'An account is for one person. It is tied to the computer you log in on, and you can move it to another computer once every 24 hours. You are responsible for everything done with your account and your Discord login. Do not share, sell or lend your account.',
  ]],
  ['Keys and time', [
    'A key adds time to your account. Each key can be used once. Nothing renews by itself: when your time ends, Grape locks until you redeem another key. Time that has been added stays on your account until it runs out.',
    'Keys are sold through our Discord and by sellers we have approved. Unless the law where you live says otherwise, a key that has been redeemed is not refunded. Do not resell keys unless we have agreed to it.',
  ]],
  ['What you must not do', [
    'Do not take Grape apart to get around its license, its keys or its one-computer limit: no reverse engineering, decompiling, patching or debugging of Grape for that purpose, and no tools that fake a license or a computer. Where the law allows reverse engineering that we cannot forbid, you may do only that.',
    'Do not share or sell installers, keys or accounts. Do not attack, overload or probe our servers, and do not try to read other people’s data. Do not use Grape to spread malware, to break the law, or to harm other people or their computers. Do not remove our notices from Grape.',
  ]],
  ['Games, servers and other programs', [
    'Grape runs the scripts you write inside games you choose, and it works with launchers and mod sites that belong to other people. We are not affiliated with, endorsed by or connected to Mojang, Microsoft, Lunar Client, Modrinth or any other company or game. Their names belong to them.',
    'You decide what your scripts do, and you are responsible for it. Games, servers and launchers have their own rules, and many multiplayer servers ban players who use modified clients or scripts. If you are banned, lose progress, or have a problem with a game or a server, that is between you and them: we are not responsible for it. Use Grape in places where it is allowed.',
  ]],
  ['Updates and availability', [
    'We update Grape and the Service, and we may change or remove features. We may require you to use a newer version: older versions can stop working. Grape needs to reach our server to check your account and open its window, so it does not work offline.',
    'We try to keep the Service running, but we do not promise it will always be available, and we may stop it for maintenance or for reasons outside our control.',
  ]],
  ['Your data', [
    'What we keep: your Discord profile (id, username, display name, picture address); a one-way fingerprint of your computer, used to keep an account on one computer; the key you redeemed and the time on your account; which installers were made for you and when they were used; and server logs, which hold dates, your internet address, your Discord id and your computer’s id, and the name and size (not the contents) of scripts you run.',
    'When you run a script, Grape sends the compiled script to our server, which checks your account and sends it back. We do not store the script. Your scripts, settings and files stay on your computer. The website uses a cookie to keep you logged in, and nothing for advertising or tracking.',
    'We use this to run the Service, to keep it safe and to stop abuse. We do not sell your data. It reaches Discord when you log in with Discord, and our hosting provider holds it for us. We keep it while your account exists and for as long as the logs are needed for security. To ask what we hold or to have it removed, contact us as described below.',
  ]],
  ['Ending this agreement', [
    'You can stop at any time by uninstalling Grape. We may suspend or end your account, and your license, if you break these terms, if we must by law, or if you abuse the Service. If we end your account because you broke these terms, the time left on it is not refunded.',
    'Sections that by their nature should continue after the end of this agreement do so, for example “No warranty” and “Our liability”.',
  ]],
  ['No warranty', [
    'Grape and the Service are given “as is” and “as available”. We make no promise that Grape will work in every game, version or client, that it will be free of errors, or that it will not be affected by changes made by others. To the extent the law allows, we give no warranties of any kind, express or implied.',
  ]],
  ['Our liability', [
    'To the extent the law allows, we are not liable for lost progress, bans, lost data, lost profits or any indirect or consequential damage that comes from using or not being able to use Grape. If we are found liable to you despite this, our liability is limited to what you paid for the time that was on your account when the problem happened. Nothing here limits a liability that cannot be limited by law.',
  ]],
  ['Changes to these terms', [
    'We may change these terms. When we do, we change the date at the top of this page. If you keep using Grape after a change, you accept the new terms. If you do not accept them, stop using Grape.',
  ]],
];

export default async function Terms() {
  const g = grape();
  const site = g ? g.site() : { discord_url: '', download_ready: false };
  const user = await siteUser();
  return (
    <>
      <SiteStyle />
      <Nav user={user} site={site} ready={!!site.download_ready} />
      <main>
        <article className="legal">
          <h1>Terms of Service</h1>
          <p className="updated">Last updated {UPDATED}</p>
          {SECTIONS.map(([title, paragraphs], i) => (
            <section key={title}>
              <h2>{i + 1}. {title}</h2>
              {paragraphs.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}
            </section>
          ))}
          <section>
            <h2>{SECTIONS.length + 1}. Contact</h2>
            <p>
              {site.discord_url ? <>For questions about these terms, or about your data, ask in <a href={site.discord_url} rel="noreferrer">our Discord</a>.</> : 'For questions about these terms, or about your data, ask us in our Discord.'}
            </p>
          </section>
        </article>
      </main>
      <Foot user={user} site={site} />
    </>
  );
}
