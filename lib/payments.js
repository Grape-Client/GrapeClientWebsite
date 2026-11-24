// Payments in crypto: USDT on BNB Smart Chain (BEP20) and Litecoin, to buy a plan on the website. Nothing to do with the
// program: people cannot buy in Grape, only here.
//
//   One wallet, from one 24-word seed (data/wallet.json, made in Admin > Payments > Wallet or `node server.js wallet-init`):
//     USDT  deposit addresses  m/44'/60'/0'/0/<n>   one per order
//           collector          m/44'/60'/1'/0/0     holds BNB for gas, and collects the USDT of every order
//     LTC   deposit addresses  m/84'/2'/0'/0/<n>    one per order (ltc1... addresses)
//           collector          m/84'/2'/1'/0/0      collects the LTC of every order
//
//   1. a logged-in person picks a plan and a coin: an order is made with its own deposit address and the exact amount
//      (USDT = the plan's dollar price; LTC = the dollar price at the rate of that moment, kept for the order's time)
//   2. every 20 s the server looks at the addresses of the open orders. When enough has arrived, with the confirmations
//      the settings ask for, the plan's time is added to that person's Discord account (no key needed)
//   3. the money is moved to the collector. For USDT the collector first sends the deposit address just enough BNB for
//      the gas of one token transfer. For LTC the network fee is taken from what is moved
//   4. cash-out: what the collector holds goes to the admin's own main address - by itself after each payment (auto,
//      once at least the minimum has gathered), or when the admin presses Cash out
//
//   Nothing waits for a timer when it does not have to: the server listens to both blockchains over WebSockets (BSC: new
//   blocks, and USDT transfers to the open deposit addresses; Litecoin: new blocks and the open addresses), so a payment
//   is seen within seconds and its confirmations are counted block by block; and the buyer's page hears every change
//   by a push (c.onOrder -> the page's WebSocket, lib/core.js). The 20-second look stays, in case a socket is down.
//
//   Everything that touches a blockchain goes through `chains` (real ones below; the tests give fake ones).
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COINS = {
  usdt_bsc: { symbol: 'USDT', name: 'USDT', network: 'BNB Smart Chain (BEP20)', decimals: 18, show: 2, explorer: 'https://bscscan.com' },
  ltc: { symbol: 'LTC', name: 'Litecoin', network: 'Litecoin', decimals: 8, show: 8, explorer: 'https://litecoinspace.org' },
};
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';      // Tether USD on BNB Smart Chain (18 decimals)
const LTC_NET = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
const PATHS = {
  usdt_bsc: { deposit: (n) => `m/44'/60'/0'/0/${n}`, collector: "m/44'/60'/1'/0/0" },
  ltc: { deposit: (n) => `m/84'/2'/0'/0/${n}`, collector: "m/84'/2'/1'/0/0" },
};
const DAY_MS = 24 * 3600 * 1000;
const WATCH_MS = DAY_MS;                     // an order is looked at for a day: money sent late still counts
const OPEN = ['waiting', 'seen', 'partial'];
const DEFAULTS = {
  enabled: { usdt_bsc: true, ltc: true },
  payout: { usdt_bsc: '', ltc: '' },
  auto: { usdt_bsc: false, ltc: false },
  min_cashout: { usdt_bsc: 10, ltc: 0.1 },
  confirmations: { usdt_bsc: 15, ltc: 2 },
  order_minutes: 60,
  bsc_rpc: 'https://bsc-dataseed.binance.org/',
  ltc_api: 'https://litecoinspace.org/api',
  bsc_wss: 'wss://bsc-rpc.publicnode.com',
  ltc_wss: 'wss://litecoinspace.org/api/v1/ws',
};
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';   // keccak("Transfer(address,address,uint256)")

// ---- amounts: whole numbers of the smallest unit (BigInt), shown as decimals

function toBase(decimal, decimals) {
  const text = String(decimal).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Not an amount: ' + text);
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
function fromBase(base, decimals, maxFrac = decimals) {
  const value = BigInt(base);
  const unit = 10n ** BigInt(decimals);
  const frac = (value % unit).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return (value / unit).toString() + (frac ? '.' + frac : '');
}
const sum = (list) => list.reduce((a, u) => a + u.value, 0n);

module.exports = function payments(c) {
  const { DATA, read, write, log, alert, tooMany } = c;
  const WALLET = path.join(DATA, 'wallet.json');
  const ORDERS = path.join(DATA, 'payments.json');
  const SET = path.join(DATA, 'payment-settings.json');
  const tries = new Map();
  const cashing = {};

  // ---- settings

  function settings() {
    const s = read(SET);
    const out = JSON.parse(JSON.stringify(DEFAULTS));
    for (const key of Object.keys(DEFAULTS)) {
      if (s[key] === undefined) continue;
      if (typeof DEFAULTS[key] === 'object') Object.assign(out[key], s[key]);
      else out[key] = s[key];
    }
    return out;
  }

  /** Whether `address` can be paid in that coin. Empty is allowed (no address yet). */
  function validAddress(coin, address) {
    if (!address) return true;
    if (coin === 'usdt_bsc') return /^0x[0-9a-fA-F]{40}$/.test(address) && require('ethers').isAddress(address);
    try { require('@scure/btc-signer').Address(LTC_NET).decode(address); return true; } catch { return false; }
  }

  function saveSettings(body) {
    const before = settings();
    const next = JSON.parse(JSON.stringify(before));
    const number = (v, min, max, what) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${what} must be a number from ${min} to ${max}.`);
      return n;
    };
    for (const coin of Object.keys(COINS)) {
      const sym = COINS[coin].symbol;
      if (body.enabled && coin in body.enabled) next.enabled[coin] = body.enabled[coin] === true;
      if (body.auto && coin in body.auto) next.auto[coin] = body.auto[coin] === true;
      if (body.payout && coin in body.payout) {
        const a = String(body.payout[coin] || '').trim();
        if (!validAddress(coin, a)) throw new Error(`That is not a ${coin === 'ltc' ? 'Litecoin' : 'BNB Smart Chain (0x...)'} address.`);
        next.payout[coin] = a;
      }
      if (body.min_cashout && coin in body.min_cashout) next.min_cashout[coin] = number(body.min_cashout[coin], 0, 1e6, `The minimum cash-out of ${sym}`);
      if (body.confirmations && coin in body.confirmations) next.confirmations[coin] = Math.round(number(body.confirmations[coin], 1, 100, `The confirmations of ${sym}`));
    }
    if (body.order_minutes !== undefined) next.order_minutes = Math.round(number(body.order_minutes, 15, 240, 'The time to pay'));
    for (const key of ['bsc_rpc', 'ltc_api']) {
      if (body[key] === undefined) continue;
      const url = String(body[key] || '').trim().replace(/\/+$/, '');
      if (!/^https:\/\/[^\s]+$/.test(url)) throw new Error('The blockchain addresses must be https:// addresses.');
      next[key] = key === 'bsc_rpc' ? url + '/' : url;
    }
    for (const key of ['bsc_wss', 'ltc_wss']) {
      if (body[key] === undefined) continue;
      const url = String(body[key] || '').trim();
      if (url && !/^wss:\/\/[^\s]+$/.test(url)) throw new Error('The live blockchain addresses must be wss:// addresses (or empty, to only look every 20 s).');
      next[key] = url;
    }
    write(SET, next);
    const payoutChanged = Object.keys(COINS).filter((coin) => before.payout[coin] !== next.payout[coin]);
    log(`payments: settings saved${payoutChanged.length ? ' (main address changed: ' + payoutChanged.join(', ') + ')' : ''}`);
    return { settings: next, payoutChanged };
  }

  // ---- the wallet

  const wallet = () => { const w = read(WALLET); return typeof w.mnemonic === 'string' ? w : null; };
  let root = null, rootOf = '';
  function hd() {
    const w = wallet();
    if (!w) throw new Error('The payment wallet is not set up yet (Admin > Payments > Wallet).');
    if (rootOf !== w.mnemonic) {
      const { HDKey } = require('@scure/bip32');
      root = HDKey.fromMasterSeed(require('@scure/bip39').mnemonicToSeedSync(w.mnemonic));
      rootOf = w.mnemonic;
    }
    return root;
  }
  /** The key and address of a deposit address (`which` = its number) or of the collector. */
  function keyAt(coin, which) {
    const k = hd().derive(which === 'collector' ? PATHS[coin].collector : PATHS[coin].deposit(which));
    const address = coin === 'usdt_bsc'
      ? require('ethers').computeAddress('0x' + Buffer.from(k.publicKey).toString('hex'))
      : require('@scure/btc-signer').p2wpkh(k.publicKey, LTC_NET).address;
    return { priv: k.privateKey, pub: k.publicKey, address };
  }
  const collectors = () => (wallet() ? { usdt_bsc: keyAt('usdt_bsc', 'collector').address, ltc: keyAt('ltc', 'collector').address } : null);

  function keepSecret() { try { fs.chmodSync(WALLET, 0o600); } catch { /* Windows */ } }

  /** A new seed: shown here once, kept only in data/wallet.json (and in the encrypted backups). */
  function createWallet() {
    if (wallet()) throw new Error('A payment wallet already exists. It is never replaced: the money of every order depends on it.');
    const { generateMnemonic } = require('@scure/bip39');
    const mnemonic = generateMnemonic(require('@scure/bip39/wordlists/english').wordlist, 256);
    write(WALLET, { mnemonic, created: Date.now() });
    keepSecret();
    log('payments: a new payment wallet was created');
    alert('wallet', 'A new payment wallet was created.');
    return { mnemonic, collectors: collectors() };
  }
  function importWallet(mnemonic) {
    if (wallet()) throw new Error('A payment wallet already exists.');
    const words = String(mnemonic || '').trim().toLowerCase().split(/\s+/).join(' ');
    if (!require('@scure/bip39').validateMnemonic(words, require('@scure/bip39/wordlists/english').wordlist)) throw new Error('Those words are not a valid seed.');
    write(WALLET, { mnemonic: words, created: Date.now(), imported: true });
    keepSecret();
    log('payments: a payment wallet was imported');
    alert('wallet', 'A payment wallet was imported.');
    return { collectors: collectors() };
  }

  // ---- the blockchains

  let bscCache = null;
  function bsc() {
    const url = settings().bsc_rpc;
    if (!bscCache || bscCache.url !== url) {
      const { JsonRpcProvider, Contract } = require('ethers');
      const provider = new JsonRpcProvider(url, 56, { staticNetwork: true });
      const abi = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
      bscCache = { url, provider, token: new Contract(USDT_BSC, abi, provider), abi };
    }
    return bscCache;
  }
  async function ltcApi(route, init) {
    const r = await fetch(settings().ltc_api + route, { ...init, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`the Litecoin service said ${r.status}: ${text.slice(0, 120)}`);
    try { return JSON.parse(text); } catch { return text.trim(); }
  }
  const real = {
    usdt_bsc: {
      async balances(address, confirmations) {
        const { provider, token } = bsc();
        const tip = await provider.getBlockNumber();
        const [pending, confirmed] = await Promise.all([
          token.balanceOf(address, { blockTag: tip }),
          token.balanceOf(address, { blockTag: Math.max(0, tip - confirmations + 1) }),
        ]);
        return { pending: BigInt(pending), confirmed: BigInt(confirmed) };
      },
      async native(address) { return BigInt(await bsc().provider.getBalance(address)); },
      async gasPrice() { const f = await bsc().provider.getFeeData(); return BigInt(f.gasPrice || 1000000000n); },
      async estimate(from, to, amount) {
        try { return BigInt(await bsc().token.transfer.estimateGas(to, amount, { from })); } catch { return 70000n; }
      },
      async sendNative(priv, to, value, gasPrice) {
        const { Wallet } = require('ethers');
        const signer = new Wallet('0x' + Buffer.from(priv).toString('hex'), bsc().provider);
        const tx = await signer.sendTransaction({ to, value, gasLimit: 21000n, gasPrice });
        await tx.wait(1);
        return tx.hash;
      },
      async sendToken(priv, to, amount, gasPrice, gasLimit) {
        const { Wallet, Contract } = require('ethers');
        const signer = new Wallet('0x' + Buffer.from(priv).toString('hex'), bsc().provider);
        const tx = await new Contract(USDT_BSC, bsc().abi, signer).transfer(to, amount, { gasPrice, gasLimit });
        await tx.wait(1);
        return tx.hash;
      },
    },
    ltc: {
      async utxos(address) {
        const [list, tip] = await Promise.all([ltcApi(`/address/${address}/utxo`), ltcApi('/blocks/tip/height')]);
        return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmations: u.status && u.status.confirmed ? Number(tip) - u.status.block_height + 1 : 0 }));
      },
      async feeRate() {
        try { const f = await ltcApi('/fee-estimates'); return Math.max(10, Math.ceil(f['3'] || f['6'] || 10)); } catch { return 10; }
      },
      async broadcast(hex) { return ltcApi('/tx', { method: 'POST', body: hex, headers: { 'Content-Type': 'text/plain' } }); },
    },
  };
  const chains = () => c.chains || real;

  /** Dollars per LTC, from the first price service that answers (kept for a minute). */
  let rateCache = { at: 0, usd: 0 };
  async function ltcRate() {
    if (c.ltcRate) return c.ltcRate();
    if (Date.now() - rateCache.at < 60000 && rateCache.usd > 0) return rateCache.usd;
    const sources = [
      ['https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', (j) => j.litecoin.usd],
      ['https://api.kraken.com/0/public/Ticker?pair=LTCUSD', (j) => Object.values(j.result)[0].c[0]],
      ['https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT', (j) => j.price],
    ];
    for (const [url, pick] of sources) {
      try {
        const usd = Number(pick(await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json()));
        if (usd > 1 && usd < 100000) { rateCache = { at: Date.now(), usd }; return usd; }
      } catch { /* the next one */ }
    }
    throw new Error('The Litecoin price could not be found right now. Try again in a minute, or pay with USDT.');
  }

  /** Sends everything in `utxos` (of `key`'s address) to `to`, less the network fee: the new transaction's id. */
  async function ltcSend(key, utxos, to) {
    if (!utxos.length) return null;
    const btc = require('@scure/btc-signer');
    const total = sum(utxos);
    const fee = BigInt(await chains().ltc.feeRate()) * (11n + 68n * BigInt(utxos.length) + 34n);
    if (total - fee < 1000n) throw new Error('There is too little LTC to move after the network fee.');
    const script = btc.p2wpkh(key.pub, LTC_NET).script;
    const tx = new btc.Transaction();
    for (const u of utxos) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: u.value } });
    tx.addOutputAddress(to, total - fee, LTC_NET);
    tx.sign(key.priv);
    tx.finalize();
    return chains().ltc.broadcast(tx.hex);
  }

  /** Sends `amount` of the LTC in `utxos` to `to`; what is left (less the fee) goes back to the same address. */
  async function ltcSendSome(key, utxos, to, amount) {
    const btc = require('@scure/btc-signer');
    const total = sum(utxos);
    const fee = BigInt(await chains().ltc.feeRate()) * (11n + 68n * BigInt(utxos.length) + 34n + 31n);
    const change = total - amount - fee;
    if (amount < 1000n) throw new Error('That amount is too small to send.');
    if (change < 0n) throw new Error(`Not enough LTC for that and the network fee (${fromBase(fee, 8)} LTC). The most you can send is ${fromBase(total - fee > 0n ? total - fee : 0n, 8)} LTC.`);
    const own = btc.p2wpkh(key.pub, LTC_NET);
    const tx = new btc.Transaction();
    for (const u of utxos) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: own.script, amount: u.value } });
    tx.addOutputAddress(to, amount, LTC_NET);
    if (change >= 1000n) tx.addOutputAddress(own.address, change, LTC_NET);   // a smaller rest is left to the fee
    tx.sign(key.priv);
    tx.finalize();
    return chains().ltc.broadcast(tx.hex);
  }

  // ---- orders

  const update = (fn) => { const d = read(ORDERS); d.orders = d.orders || {}; d.next = d.next || {}; d.cashouts = d.cashouts || []; const out = fn(d); write(ORDERS, d); return out; };
  const explorer = (coin, kind, id) => `${COINS[coin].explorer}/${kind}/${id}`;

  /** What the buyer's page shows of an order (never a key, never another person's order). */
  async function view(o) {
    const coin = COINS[o.coin];
    const amount = fromBase(o.amount_base, coin.decimals, coin.show);
    const text = o.coin === 'ltc' ? `litecoin:${o.address}?amount=${amount}` : o.address;
    let qr = '';
    try { qr = await require('qrcode').toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }); } catch { /* shown without */ }
    const now = Date.now();
    return {
      id: o.id, coin: o.coin, symbol: coin.symbol, network: coin.network, address: o.address, amount, usd: o.usd,
      plan: o.plan, plan_name: o.plan_name, created: o.created, expires: o.expires,
      status: o.status === 'waiting' && now > o.expires ? 'expired' : o.status,
      received: fromBase(o.received_base || '0', coin.decimals, coin.show),
      confirmations: settings().confirmations[o.coin], explorer: explorer(o.coin, 'address', o.address), qr,
    };
  }

  async function createOrder({ user, userName, plan, planName, coin, usd }) {
    const s = settings();
    if (!Object.hasOwn(COINS, coin) || !s.enabled[coin]) throw new Error('That way to pay is not available.');
    if (!wallet()) throw new Error('Payments are not set up yet. Try again later.');
    if (!(usd > 0)) throw new Error('That plan has no price yet.');
    const now = Date.now();
    const mine = Object.values(read(ORDERS).orders || {}).filter((o) => o.user === user && ['waiting', 'seen'].includes(o.status) && now - o.created < WATCH_MS);
    const same = mine.find((o) => o.plan === plan && o.coin === coin && o.expires > now + 5 * 60000);
    if (same) return view(same);                                       // the one already open for this: the same address
    if (mine.filter((o) => o.expires > now).length >= 3) throw new Error('You have 3 payments open. Pay one of them, or wait until they expire.');
    if (tooMany(tries, 'order:' + user, 10, 3600)) throw new Error('Too many payments started. Try again in an hour.');
    let amountBase, rate = 1;
    if (coin === 'usdt_bsc') amountBase = toBase(usd.toFixed(2), 18);
    else {
      rate = await ltcRate();
      amountBase = BigInt(Math.ceil(((usd / rate) * 1e8) / 1000) * 1000);  // in steps of 0.00001 LTC, rounded up
    }
    const order = update((d) => {
      const index = d.next[coin] || 1;
      d.next[coin] = index + 1;
      const o = {
        id: crypto.randomBytes(9).toString('base64url'), user, user_name: String(userName || '').slice(0, 60), plan, plan_name: planName, coin, usd, rate,
        index, address: keyAt(coin, index).address, amount_base: amountBase.toString(), received_base: '0',
        created: now, expires: now + s.order_minutes * 60000, status: 'waiting', swept: false,
      };
      d.orders[o.id] = o;
      return o;
    });
    log(`payments: order ${order.id} for ${user} (${planName}, ${fromBase(order.amount_base, COINS[coin].decimals, COINS[coin].show)} ${COINS[coin].symbol}) to ${order.address}`);
    syncLive();
    return view(order);
  }

  async function orderFor(user, id) {
    const o = Object.hasOwn(read(ORDERS).orders || {}, String(id)) ? read(ORDERS).orders[id] : null;
    return o && o.user === user ? view(o) : null;
  }

  /** The order is paid: the plan's time goes onto the account (once). `how`: 'paid' or 'admin'. */
  function credit(id, how) {
    const o = update((d) => {
      const cur = d.orders[id];
      if (!cur || ['paid', 'crediting'].includes(cur.status)) return null;
      if (how === 'admin' && !['partial', 'waiting', 'seen', 'error'].includes(cur.status)) return null;
      cur.status = 'crediting';
      return { ...cur };
    });
    if (!o) return null;
    let problem = '';
    try { problem = c.credit(o.user, o.plan); } catch (e) { problem = e.message || String(e); }
    const done = update((d) => {
      const cur = d.orders[id];
      if (problem && how !== 'admin') { cur.status = 'error'; cur.note = problem; return cur; }
      cur.status = 'paid'; cur.credited_at = Date.now(); cur.paid_how = how; cur.note = problem;
      return cur;
    });
    notify(id);
    const coin = COINS[done.coin];
    if (done.status === 'paid') {
      log(`payments: order ${id} paid${how === 'admin' ? ' (credited by the admin)' : ''}: ${done.plan_name} for ${done.user}`);
      alert('payment', `${done.user_name || done.user} paid ${fromBase(done.received_base || done.amount_base, coin.decimals, coin.show)} ${coin.symbol} for ${done.plan_name}.`);
    } else {
      log(`payments: order ${id} was paid but the time could not be added: ${problem}`);
      alert('payment-error', `A payment arrived (order ${id}) but the time could not be added: ${problem}`);
    }
    return done;
  }

  /** Has enough arrived at an open order's address? */
  async function check(o, s) {
    const need = BigInt(o.amount_base);
    let confirmed, pending;
    if (o.coin === 'usdt_bsc') ({ confirmed, pending } = await chains().usdt_bsc.balances(o.address, s.confirmations.usdt_bsc));
    else {
      const u = await chains().ltc.utxos(o.address);
      confirmed = sum(u.filter((x) => x.confirmations >= s.confirmations.ltc));
      pending = sum(u);
    }
    // USDT: a cent less is accepted; LTC: 1 % less (a wallet that rounds, or takes its fee out of the amount)
    const enough = (got) => (o.coin === 'usdt_bsc' ? got + 10n ** 16n >= need : got * 100n >= need * 99n);
    const { paid, changed } = update((d) => {
      const cur = d.orders[o.id];
      if (!cur || !OPEN.includes(cur.status)) return { paid: false, changed: false };
      const before = cur.status + ':' + cur.received_base;
      cur.received_base = (pending > confirmed ? pending : confirmed).toString();
      cur.checked = Date.now();
      if (confirmed > 0n && enough(confirmed)) return { paid: true, changed: true };
      cur.status = confirmed > 0n ? 'partial' : pending > 0n ? 'seen' : 'waiting';
      return { paid: false, changed: before !== cur.status + ':' + cur.received_base };
    });
    if (paid) credit(o.id, 'paid');
    else if (changed) notify(o.id);
  }

  /** The buyer's page hears what happened to its order (a push: lib/core.js sends it down the page's WebSocket). */
  async function notify(id) {
    if (typeof c.onOrder !== 'function') return;
    try {
      const o = (read(ORDERS).orders || {})[id];
      if (o) c.onOrder(id, await view(o));
    } catch (e) { log(`payments: could not tell the page about ${id}: ${e.message}`); }
  }

  /** Look at one order now (a blockchain socket said something happened to it). Never twice at once. */
  const checking = new Set();
  async function kick(id) {
    if (checking.has(id) || !wallet()) return;
    const o = (read(ORDERS).orders || {})[id];
    if (!o || !OPEN.includes(o.status) || Date.now() - o.created >= WATCH_MS) return;
    checking.add(id);
    try { await check(o, settings()); } catch (e) { log(`payments: could not look at order ${id}: ${e.message}`); } finally { checking.delete(id); }
  }

  const markSwept = (id, tx, note) => update((d) => { const o = d.orders[id]; o.swept = true; o.sweep_tx = tx || ''; o.sweep_error = ''; o.swept_at = Date.now(); if (note) o.sweep_note = note; });

  /** The money of a paid order goes to the collector. */
  async function sweep(o) {
    if (o.coin === 'usdt_bsc') {
      const ch = chains().usdt_bsc;
      const dep = keyAt('usdt_bsc', o.index), col = keyAt('usdt_bsc', 'collector');
      const { pending: amount } = await ch.balances(dep.address, 1);
      if (amount === 0n) return markSwept(o.id, '', 'nothing to move');
      const gasPrice = await ch.gasPrice();
      const gasLimit = ((await ch.estimate(dep.address, col.address, amount)) * 13n) / 10n;
      const need = gasLimit * gasPrice;
      const have = await ch.native(dep.address);
      if (have < need) {
        if ((await ch.native(col.address)) < need - have + 21000n * gasPrice) throw new Error(`the collector has no BNB left for gas: send some BNB (BEP20) to ${col.address}`);
        await ch.sendNative(col.priv, dep.address, need - have, gasPrice);
      }
      const tx = await ch.sendToken(dep.priv, col.address, amount, gasPrice, gasLimit);
      log(`payments: order ${o.id}: ${fromBase(amount, 18, 2)} USDT moved to the collector (${tx})`);
      return markSwept(o.id, tx);
    }
    const dep = keyAt('ltc', o.index);
    const utxos = (await chains().ltc.utxos(dep.address)).filter((u) => u.confirmations >= 1);
    if (!utxos.length) return markSwept(o.id, '', 'nothing to move');
    const tx = await ltcSend(dep, utxos, keyAt('ltc', 'collector').address);
    log(`payments: order ${o.id}: ${fromBase(sum(utxos), 8)} LTC moved to the collector (${tx})`);
    return markSwept(o.id, tx);
  }

  /** Money leaves a collector: everything it holds (`amount` null) or `amount` (a decimal), to `to`. `auto`: a cash-out
   *  that runs by itself, only once the minimum has gathered. Null when there is nothing to send. */
  async function sendFrom(coin, to, amount, { auto = false, kind = 'cashout' } = {}) {
    if (!Object.hasOwn(COINS, coin)) throw new Error('Unknown coin.');
    if (!to || !validAddress(coin, to)) throw new Error(`That is not a ${coin === 'ltc' ? 'Litecoin' : 'BNB Smart Chain (0x...)'} address.`);
    const s = settings();
    if (cashing[coin]) throw new Error('Money of that coin is already being sent. Wait a moment.');
    cashing[coin] = true;
    try {
      const col = keyAt(coin, 'collector');
      if (to.toLowerCase() === col.address.toLowerCase()) throw new Error('That is the collector itself.');
      let tx, sent;
      if (coin === 'usdt_bsc') {
        const ch = chains().usdt_bsc;
        const { pending: balance } = await ch.balances(col.address, 1);
        const want = amount === null ? balance : toBase(String(amount), 18);
        if (amount === null && (balance === 0n || (auto && balance < toBase(String(s.min_cashout.usdt_bsc), 18)))) return null;
        if (want <= 0n) throw new Error('Type an amount above 0.');
        if (want > balance) throw new Error(`The collector holds ${fromBase(balance, 18, 2)} USDT.`);
        const gasPrice = await ch.gasPrice();
        const gasLimit = ((await ch.estimate(col.address, to, want)) * 13n) / 10n;
        if ((await ch.native(col.address)) < gasLimit * gasPrice) throw new Error(`The collector has no BNB for gas: send some BNB (BEP20) to ${col.address}`);
        tx = await ch.sendToken(col.priv, to, want, gasPrice, gasLimit);
        sent = fromBase(want, 18, 2);
      } else {
        const utxos = (await chains().ltc.utxos(col.address)).filter((u) => u.confirmations >= 1);
        const total = sum(utxos);
        if (amount === null) {
          if (total === 0n || (auto && total < toBase(String(s.min_cashout.ltc), 8))) return null;
          tx = await ltcSend(col, utxos, to);
          sent = fromBase(total, 8);
        } else {
          const want = toBase(String(amount), 8);
          if (!utxos.length) throw new Error('The collector has no confirmed LTC yet.');
          tx = await ltcSendSome(col, utxos, to, want);
          sent = fromBase(want, 8);
        }
      }
      const record = { coin, amount: sent, symbol: COINS[coin].symbol, to, tx, at: Date.now(), auto, kind, explorer: explorer(coin, 'tx', tx) };
      update((d) => { d.cashouts.unshift(record); d.cashouts = d.cashouts.slice(0, 200); });
      const what = kind === 'send' ? 'Sent' : auto ? 'Cash-out (auto)' : 'Cash-out';
      log(`payments: ${what.toLowerCase()} of ${sent} ${record.symbol} to ${to} (${tx})`);
      alert(kind === 'send' ? 'send' : 'cashout', `${what}: ${sent} ${record.symbol} to ${to}.`);
      return record;
    } finally {
      cashing[coin] = false;
    }
  }

  /** What the collector holds goes to the admin's main address. `auto`: only once the minimum has gathered. */
  async function cashOut(coin, { auto = false } = {}) {
    if (!Object.hasOwn(COINS, coin)) throw new Error('Unknown coin.');
    const to = settings().payout[coin];
    if (!to) throw new Error(`Set your main ${COINS[coin].symbol} address first.`);
    return sendFrom(coin, to, null, { auto, kind: 'cashout' });
  }

  /** The admin sends some of a collector - or all of it, when the amount is "max" - to any address (Admin > USDT / LTC >
   *  Send). An empty amount is refused: it must never mean "everything" by accident. */
  async function send(coin, to, amount) {
    const text = String(amount ?? '').trim().toLowerCase();
    if (!text) throw new Error('Type an amount, or press Max.');
    if (text !== 'max' && !/^\d+(\.\d+)?$/.test(text)) throw new Error('Type the amount as a number, like 12.5.');
    return sendFrom(coin, String(to || '').trim(), text === 'max' ? null : text, { kind: 'send' });
  }

  /** One coin as a small wallet: the balance, what came in and went out, by day, and the address to receive at. */
  async function walletState(coin) {
    if (!Object.hasOwn(COINS, coin)) throw new Error('Unknown coin.');
    const meta = COINS[coin];
    const s = settings();
    const out = { coin, symbol: meta.symbol, name: meta.name, network: meta.network, wallet: !!wallet(), payout: s.payout[coin], auto: s.auto[coin], min_cashout: s.min_cashout[coin], enabled: s.enabled[coin] };
    if (!out.wallet) return out;
    const col = keyAt(coin, 'collector').address;
    out.address = col;
    out.explorer = explorer(coin, 'address', col);
    try { out.qr = await require('qrcode').toString(coin === 'ltc' ? 'litecoin:' + col : col, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }); } catch { out.qr = ''; }
    try {
      if (coin === 'usdt_bsc') {
        const ch = chains().usdt_bsc;
        const [b, n] = await Promise.all([ch.balances(col, 1), ch.native(col)]);
        out.balance = fromBase(b.pending, 18, 2);
        out.gas = fromBase(n, 18, 6);
        out.gas_low = n < 3n * 10n ** 15n;
      } else {
        const u = await chains().ltc.utxos(col);
        out.balance = fromBase(sum(u), 8);
        out.confirmed = fromBase(sum(u.filter((x) => x.confirmations >= 1)), 8);
      }
    } catch (e) { out.error = e.message; }
    out.rate = coin === 'usdt_bsc' ? 1 : await ltcRate().catch(() => 0);

    const d = read(ORDERS);
    const now = Date.now();
    const paid = Object.values(d.orders || {}).filter((o) => o.coin === coin && o.status === 'paid');
    const got = (o) => BigInt(o.received_base && o.received_base !== '0' ? o.received_base : o.amount_base);
    const total = (list) => list.reduce((a, o) => a + got(o), 0n);
    const when = (o) => o.credited_at || o.created;
    const outs = (d.cashouts || []).filter((x) => x.coin === coin);
    out.totals = {
      received: fromBase(total(paid), meta.decimals, meta.show),
      payments: paid.length,
      usd: paid.reduce((a, o) => a + (o.usd || 0), 0),
      last30: fromBase(total(paid.filter((o) => now - when(o) < 30 * DAY_MS)), meta.decimals, meta.show),
      moving: fromBase(total(paid.filter((o) => !o.swept)), meta.decimals, meta.show),
      sent: fromBase(outs.reduce((a, x) => a + toBase(String(x.amount), meta.decimals), 0n), meta.decimals, meta.show),
    };
    // the last 30 days, by UTC day
    out.daily = [];
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    for (let i = 29; i >= 0; i--) {
      const from = today - i * DAY_MS, to = from + DAY_MS;
      const that = paid.filter((o) => when(o) >= from && when(o) < to);
      out.daily.push({ day: new Date(from).toISOString().slice(0, 10), amount: Number(fromBase(total(that), meta.decimals, meta.show)), payments: that.length });
    }
    out.activity = [
      ...paid.map((o) => ({ kind: 'in', at: when(o), amount: fromBase(got(o), meta.decimals, meta.show), usd: o.usd, who: o.user_name || o.user, plan: o.plan_name, moved: !!o.swept, sweep_error: o.sweep_error || '', link: o.sweep_tx ? explorer(coin, 'tx', o.sweep_tx) : explorer(coin, 'address', o.address) })),
      ...outs.map((x) => ({ kind: x.kind === 'send' ? 'send' : 'out', at: x.at, amount: x.amount, to: x.to, auto: !!x.auto, link: x.explorer })),
    ].sort((a, b) => b.at - a.at).slice(0, 200);
    return out;
  }

  // ---- listening to the blockchains (WebSockets)

  /** The orders of a coin that are still waiting for money. */
  const openOf = (coin) => Object.values(read(ORDERS).orders || {}).filter((o) => o.coin === coin && OPEN.includes(o.status) && Date.now() - o.created < WATCH_MS);

  /** A WebSocket that opens again by itself after it drops (5 s, then longer, up to a minute). */
  function liveSocket(name, url, handlers) {
    const me = { ws: null, url, open: false, closed: false, wait: 5000 };
    const connect = () => {
      if (me.closed) return;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { log(`payments: ${name} live: ${e.message}`); return later(); }
      me.ws = ws;
      ws.onopen = () => { me.open = true; me.wait = 5000; log(`payments: ${name} live connection open`); handlers.open(me); };
      ws.onmessage = (m) => { try { handlers.message(me, JSON.parse(String(m.data))); } catch { /* not for us */ } };
      ws.onclose = () => { const was = me.open; me.open = false; me.ws = null; if (was) log(`payments: ${name} live connection closed`); later(); };
      ws.onerror = () => { /* onclose follows */ };
    };
    const later = () => { if (me.closed) return; setTimeout(connect, me.wait).unref?.(); me.wait = Math.min(60000, me.wait * 2); };
    me.send = (v) => { if (me.open && me.ws) me.ws.send(JSON.stringify(v)); };
    me.stop = () => { me.closed = true; try { me.ws && me.ws.close(); } catch { /* gone */ } };
    connect();
    return me;
  }

  const live = { bsc: null, ltc: null, bscLogs: '', bscLogsId: null, bscHeadsId: null, ltcAddrs: '', headAt: 0 };
  const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  /** BSC: new blocks (to count confirmations) and USDT transfers to the open deposit addresses (to see a payment at once). */
  function bscSubscribe(sock) {
    const open = openOf('usdt_bsc');
    const key = open.map((o) => o.address.toLowerCase()).sort().join(',');
    if (key === live.bscLogs && sock.subscribed) return;
    if (live.bscLogsId) sock.send({ jsonrpc: '2.0', id: 3, method: 'eth_unsubscribe', params: [live.bscLogsId] });
    live.bscLogsId = null;
    live.bscLogs = key;
    if (!sock.subscribed) { sock.send({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }); sock.subscribed = true; }
    if (open.length) sock.send({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['logs', { address: USDT_BSC, topics: [TRANSFER, null, open.map((o) => pad(o.address))] }] });
  }

  /** Litecoin: new blocks, and the open addresses (a mempool.space-style server). */
  function ltcSubscribe(sock, force) {
    const open = openOf('ltc');
    const key = open.map((o) => o.address).sort().join(',');
    if (key === live.ltcAddrs && !force) return;
    live.ltcAddrs = key;
    if (force) sock.send({ action: 'want', data: ['blocks'] });
    if (open.length) sock.send({ 'track-addresses': open.map((o) => o.address) });
  }

  /** Opens the sockets a coin with open orders needs, and keeps what they listen to in step with the open orders. */
  function syncLive() {
    if (!wallet() || c.live === false) return;
    const s = settings();
    if (s.bsc_wss && s.enabled.usdt_bsc && openOf('usdt_bsc').length) {
      if (!live.bsc || live.bsc.url !== s.bsc_wss) {
        if (live.bsc) live.bsc.stop();
        live.bsc = liveSocket('BSC', s.bsc_wss, {
          open: (sock) => { sock.subscribed = false; live.bscLogs = ''; live.bscLogsId = null; bscSubscribe(sock); },
          message: (sock, m) => {
            if (m.id === 1 && m.result) live.bscHeadsId = m.result;
            if (m.id === 2 && m.result) live.bscLogsId = m.result;
            const r = m.params && m.params.result;
            if (!r) return;
            if (r.topics && r.topics[2]) {                                // USDT arrived at one of our addresses
              const to = '0x' + r.topics[2].slice(26).toLowerCase();
              for (const o of openOf('usdt_bsc')) if (o.address.toLowerCase() === to) kick(o.id);
            } else if (r.number && Date.now() - live.headAt > 3000) {      // a new block: count the confirmations again
              live.headAt = Date.now();
              for (const o of openOf('usdt_bsc')) if (o.status !== 'waiting') kick(o.id);
            }
          },
        });
      } else if (live.bsc.open) bscSubscribe(live.bsc);
    }
    if (s.ltc_wss && s.enabled.ltc && openOf('ltc').length) {
      if (!live.ltc || live.ltc.url !== s.ltc_wss) {
        if (live.ltc) live.ltc.stop();
        live.ltc = liveSocket('Litecoin', s.ltc_wss, {
          open: (sock) => { live.ltcAddrs = ''; ltcSubscribe(sock, true); },
          message: (sock, m) => {
            const text = JSON.stringify(m);
            const block = m.block || (m.blocks && !Array.isArray(m.blocks));
            for (const o of openOf('ltc')) if (block ? o.status !== 'waiting' || text.includes(o.address) : text.includes(o.address)) kick(o.id);
          },
        });
      } else if (live.ltc.open) ltcSubscribe(live.ltc, false);
    }
  }

  // ---- the loop

  let busy = false;
  async function tick() {
    if (busy || !wallet()) return;
    busy = true;
    try {
      const s = settings();
      const now = Date.now();
      for (const o of Object.values(read(ORDERS).orders || {})) {
        if (!OPEN.includes(o.status) || now - o.created >= WATCH_MS) continue;
        try { await check(o, s); } catch (e) { log(`payments: could not look at order ${o.id}: ${e.message}`); }
      }
      const closed = update((d) => {
        const ids = [];
        for (const o of Object.values(d.orders)) if (o.status === 'waiting' && now - o.created >= WATCH_MS) { o.status = 'expired'; ids.push(o.id); }
        return ids;
      });
      for (const id of closed) notify(id);
      syncLive();
      for (const o of Object.values(read(ORDERS).orders || {})) {
        if (o.status !== 'paid' || o.swept || (o.sweep_after || 0) > now) continue;
        try { await sweep(o); } catch (e) {
          update((d) => { d.orders[o.id].sweep_error = e.message; d.orders[o.id].sweep_after = Date.now() + 2 * 60000; });
          log(`payments: could not move the money of order ${o.id}: ${e.message}`);
          alert('sweep', `The money of order ${o.id} could not be moved: ${e.message}`);
        }
      }
      for (const coin of Object.keys(COINS)) {
        if (!s.auto[coin] || !s.payout[coin]) continue;
        try { await cashOut(coin, { auto: true }); } catch (e) { log(`payments: auto cash-out of ${coin}: ${e.message}`); }
      }
    } finally {
      busy = false;
    }
  }

  function start() {
    if (process.env.GRAPE_PAY_TICK_MS === '0') return;                  // the tests: nothing runs by itself
    const every = Number(process.env.GRAPE_PAY_TICK_MS) || 20000;
    setTimeout(() => tick().catch((e) => log('payments: ' + e.message)), 5000).unref();
    setInterval(() => tick().catch((e) => log('payments: ' + e.message)), every).unref();
  }

  // ---- what the admin page sees

  function list() {
    const d = read(ORDERS);
    const orders = Object.values(d.orders || {}).sort((a, b) => b.created - a.created).slice(0, 300).map((o) => {
      const coin = COINS[o.coin];
      return {
        id: o.id, user: o.user, user_name: o.user_name, plan_name: o.plan_name, coin: o.coin, symbol: coin.symbol, usd: o.usd,
        amount: fromBase(o.amount_base, coin.decimals, coin.show), received: fromBase(o.received_base || '0', coin.decimals, coin.show),
        address: o.address, created: o.created, expires: o.expires, status: o.status === 'waiting' && Date.now() > o.expires ? 'expired' : o.status,
        swept: !!o.swept, sweep_tx: o.sweep_tx || '', sweep_error: o.sweep_error || '', note: o.note || '', paid_how: o.paid_how || '',
        explorer: explorer(o.coin, 'address', o.address), sweep_explorer: o.sweep_tx ? explorer(o.coin, 'tx', o.sweep_tx) : '',
      };
    });
    return { orders, cashouts: d.cashouts || [] };
  }

  async function adminState() {
    const s = settings();
    const w = wallet();
    const out = { wallet: !!w, wallet_created: w ? w.created : 0, collectors: collectors(), settings: s, coins: COINS, balances: {} };
    const d = read(ORDERS);
    const paid = Object.values(d.orders || {}).filter((o) => o.status === 'paid');
    out.live = { bsc: !!(live.bsc && live.bsc.open), ltc: !!(live.ltc && live.ltc.open) };
    out.stats = { paid: paid.length, usd: paid.reduce((a, o) => a + (o.usd || 0), 0), open: Object.values(d.orders || {}).filter((o) => OPEN.includes(o.status) && Date.now() - o.created < WATCH_MS).length };
    if (!w) return out;
    const col = out.collectors;
    await Promise.all([
      (async () => {
        try {
          const ch = chains().usdt_bsc;
          const [b, n] = await Promise.all([ch.balances(col.usdt_bsc, 1), ch.native(col.usdt_bsc)]);
          out.balances.usdt_bsc = { amount: fromBase(b.pending, 18, 2), bnb: fromBase(n, 18, 6), gas_low: n < 3n * 10n ** 15n };
        } catch (e) { out.balances.usdt_bsc = { error: e.message }; }
      })(),
      (async () => {
        try {
          const u = await chains().ltc.utxos(col.ltc);
          out.balances.ltc = { amount: fromBase(sum(u), 8), confirmed: fromBase(sum(u.filter((x) => x.confirmations >= 1)), 8) };
        } catch (e) { out.balances.ltc = { error: e.message }; }
      })(),
    ]);
    return out;
  }

  function retrySweep(id) {
    update((d) => {
      const o = Object.hasOwn(d.orders, String(id)) ? d.orders[id] : null;
      if (!o || o.status !== 'paid') throw new Error('Only a paid order has money to move.');
      o.swept = false; o.sweep_after = 0; o.sweep_error = '';
    });
  }

  return {
    COINS, settings, saveSettings, validAddress, createWallet, importWallet, wallet: () => !!wallet(), collectors, keyAt,
    createOrder, orderFor, credit, list, adminState, cashOut, send, walletState, retrySweep, tick, start, ltcSend, kick, syncLive,
    liveState: () => ({ bsc: !!(live.bsc && live.bsc.open), ltc: !!(live.ltc && live.ltc.open) }),
  };
};
module.exports.toBase = toBase;
module.exports.fromBase = fromBase;
module.exports.COINS = COINS;
module.exports.LTC_NET = LTC_NET;
