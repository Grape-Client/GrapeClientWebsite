// What the download popup asks: GET = who is logged in and what they may do; POST = make an installer for them, or
// POST {action: 'redeem', code} = redeem a key for them (only an account with time on it gets an installer).
// All of it is done by the server's core (lib/core.js siteInstaller), the same instance server.js runs.
export const dynamic = 'force-dynamic';

function answer(request, action) {
  const grape = globalThis.grape;
  if (!grape) return Response.json({ error: 'The server is not running its core.' }, { status: 503 });
  const out = grape.siteInstaller(request.cookies.get(grape.COOKIES.site)?.value, action, request.headers.get('x-grape-ip') || '?');
  return Response.json(out.body, { status: out.status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request) {
  return answer(request, 'state');
}

export async function POST(request) {
  // only this site's own page may ask for an installer (the cookie is SameSite=Lax: a form on another site would carry it)
  const grape0 = globalThis.grape;
  if (grape0 && !grape0.sameSite((name) => request.headers.get(name), request.headers.get('host'))) return Response.json({ error: 'Not from this site.' }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch { /* no body: it is "make" */ }
  const grape = globalThis.grape;
  if (grape && body && body.action === 'redeem') {
    const out = grape.siteRedeem(request.cookies.get(grape.COOKIES.site)?.value, typeof body.code === 'string' ? body.code.slice(0, 80) : '', request.headers.get('x-grape-ip') || '?');
    return Response.json(out.body, { status: out.status, headers: { 'Cache-Control': 'no-store' } });
  }
  return answer(request, 'make');
}
