// The buy window's calls (lib/core.js sitePay): GET = the plans, the coins and who is logged in, or (?id=) how a payment
// of this person is going; POST {plan, coin} = a new payment. Buying is on the website only, never in the program.
export const dynamic = 'force-dynamic';

const json = (out) => Response.json(out.body, { status: out.status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request) {
  const grape = globalThis.grape;
  if (!grape) return Response.json({ error: 'The server is not running its core.' }, { status: 503 });
  const id = new URL(request.url).searchParams.get('id');
  const cookie = request.cookies.get(grape.COOKIES.site)?.value;
  return json(await grape.sitePay(cookie, id ? 'order' : 'state', { id }, request.headers.get('x-grape-ip') || '?'));
}

export async function POST(request) {
  const grape = globalThis.grape;
  if (!grape) return Response.json({ error: 'The server is not running its core.' }, { status: 503 });
  if (!grape.sameSite((name) => request.headers.get(name), request.headers.get('host'))) return Response.json({ error: 'Not from this site.' }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch { /* no body */ }
  const cookie = request.cookies.get(grape.COOKIES.site)?.value;
  return json(await grape.sitePay(cookie, 'create', body, request.headers.get('x-grape-ip') || '?'));
}
