// Copies the Grape window's own look into the website: its stylesheets, fonts, icons and logo (public/grape). The admin
// page is built from the same classes as the app, so it looks the same. Run again after the app's styles change.
//   node scripts/sync-app-style.mjs        (GRAPE_APP_UI=<path to the app's ui folder> if it is elsewhere)
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
// GRAPE_APP_UI if set; otherwise the newest of the repository's copy and a working copy beside it (D:\Grape)
const ui = process.env.GRAPE_APP_UI ? resolve(process.env.GRAPE_APP_UI) : [join(here, '..', 'grape-app', 'ui'), join(here, '..', '..', 'Grape', 'ui')]
  .map((p) => resolve(p)).filter((p) => existsSync(join(p, 'style.css')) && existsSync(join(p, 'fonts')))
  .sort((a, b) => statSync(join(b, 'style.css')).mtimeMs - statSync(join(a, 'style.css')).mtimeMs)[0];
if (!ui) throw new Error('The app\'s ui folder was not found: set GRAPE_APP_UI.');
const out = join(here, 'public', 'grape');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of ['style.css', 'pages.css', 'logo.png', 'fonts', 'icons', 'clients']) cpSync(join(ui, name), join(out, name), { recursive: true });
// the editor's own stylesheet (Monaco, open source; its icon font is inside it), for the live views of the landing page
mkdirSync(join(out, 'vs', 'editor'), { recursive: true });
cpSync(join(ui, 'vs', 'editor', 'editor.main.css'), join(out, 'vs', 'editor', 'editor.main.css'));
console.log(`The app's look copied from ${ui} -> public/grape`);
