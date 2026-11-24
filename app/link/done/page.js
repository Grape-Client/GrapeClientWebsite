import OpenGrape from './OpenGrape';
import { SiteStyle } from '../../_site/parts';

export const metadata = { title: 'Logged in to Grape', robots: { index: false } };

export default async function Done({ searchParams }) {
  const { name, here } = await searchParams;
  const elsewhere = here === '0';
  return (
    <main className="center">
      <SiteStyle />
      <div className="center-box">
        <img src="/grape/logo.png" alt="" />
        <h1>{name ? `Logged in as ${name}` : 'Logged in'}</h1>
        <p>{elsewhere ? 'Your account is locked to another computer. In Grape, use "Use it on this computer".' : 'Grape continues by itself. You can close this tab.'}</p>
        <OpenGrape />
      </div>
    </main>
  );
}
