import AdminApp from './AdminApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Grape Admin', robots: { index: false, follow: false } };

export default async function AdminPage({ searchParams }) {
  const { setup } = await searchParams;
  return (
    <>
      {/* the Grape window's own stylesheets (scripts/sync-app-style.mjs), then what only the admin page has */}
      <link rel="stylesheet" href="/grape/style.css" precedence="app" />
      <link rel="stylesheet" href="/grape/pages.css" precedence="app" />
      <link rel="stylesheet" href="/site/admin.css" precedence="page" />
      <AdminApp setup={typeof setup === 'string' ? setup : ''} />
    </>
  );
}
