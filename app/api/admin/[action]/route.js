// The admin page's calls: POST /api/admin/<action> with JSON. All of it is done by the server's core (lib/core.js
// adminApi), the same instance server.js runs: this route only carries the cookie, the address and the answer.
export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  const { action } = await params;
  const grape = globalThis.grape;
  if (!grape) return Response.json({ error: 'The server is not running its core (start it with node server.js).' }, { status: 503 });
  // only this site's own page may call it (the cookie is SameSite=Strict too)
  if (!grape.sameSite((name) => request.headers.get(name), request.headers.get('host'))) return Response.json({ error: 'Not from this site.' }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch { /* no body */ }
  const out = await grape.adminApi(action, body, {
    ip: request.headers.get('x-grape-ip') || '?',
    cookie: request.cookies.get(grape.COOKIES.admin)?.value,
  });
  const response = Response.json(out.body, { status: out.status, headers: { 'Cache-Control': 'no-store' } });
  if (out.cookie !== undefined) {
    const secure = grape.publicUrl().startsWith('https://') ? '; Secure' : '';
    response.headers.append('Set-Cookie', `${grape.COOKIES.admin}=${out.cookie}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${out.cookie ? 43200 : 0}`);
  }
  return response;
}
