// The payments engine (lib/payments.js) against fake blockchains: every step of an order, without real money.
//   node --test test/payments.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const makePayments = require('../lib/payments.js');
const { computeAddress } = require('ethers');
const btc = require('@scure/btc-signer');
const { LTC_NET, toBase, fromBase } = makePayments;

// the well-known test seed of Hardhat: its addresses are published, so the derivation can be checked against them
const SEED = 'test test test test test test test test test test test junk';
const USDT = 10n ** 18n;

/** A payments engine on a data folder of its own, with fake chains and a fake account store. */
function setup({ ltcRate = 100 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grape-pay-'));
  const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; } };
  const write = (f, v) => writeFileSync(f, JSON.stringify(v));
  const logs = [], alerts = [], credits = [], pushes = [];
  const chain = { tok: {}, native: {}, utxos: {}, sent: [], broadcasts: [] };
  const addrOf = (priv) => computeAddress('0x' + Buffer.from(priv).toString('hex'));
  const chains = {
    usdt_bsc: {
      async balances(a) { const t = chain.tok[a] || {}; return { pending: t.pending ?? t.confirmed ?? 0n, confirmed: t.confirmed ?? 0n }; },
      async native(a) { return chain.native[a] ?? 0n; },
      async gasPrice() { return 1_000_000_000n; },
      async estimate() { return 50_000n; },
      async sendNative(priv, to, value) {
        const from = addrOf(priv);
        chain.native[from] = (chain.native[from] ?? 0n) - value;
        chain.native[to] = (chain.native[to] ?? 0n) + value;
        chain.sent.push({ kind: 'bnb', from, to, value });
        return '0xbnb' + chain.sent.length;
      },
      async sendToken(priv, to, amount, gasPrice, gasLimit) {
        const from = addrOf(priv);
        if ((chain.native[from] ?? 0n) < gasPrice * gasLimit) throw new Error('insufficient funds for gas');
        const f = chain.tok[from] || (chain.tok[from] = {});
        f.confirmed = (f.confirmed ?? 0n) - amount; f.pending = f.confirmed;
        const t = chain.tok[to] || (chain.tok[to] = {});
        t.confirmed = (t.confirmed ?? 0n) + amount; t.pending = t.confirmed;
        chain.sent.push({ kind: 'usdt', from, to, amount });
        return '0xusdt' + chain.sent.length;
      },
    },
    ltc: {
      async utxos(a) { return chain.utxos[a] || []; },
      async feeRate() { return 10; },
      async broadcast(hex) {
        const tx = btc.Transaction.fromRaw(Buffer.from(hex, 'hex'));
        const out = tx.getOutput(0);
        const to = btc.Address(LTC_NET).encode(btc.OutScript.decode(out.script));
        chain.broadcasts.push({ hex, to, amount: out.amount, inputs: tx.inputsLength });
        const id = 'ab'.repeat(31) + String(chain.broadcasts.length).padStart(2, '0');
        // what was spent is gone; what was sent arrives (confirmed, for the test)
        for (const a of Object.keys(chain.utxos)) chain.utxos[a] = [];
        chain.utxos[to] = [...(chain.utxos[to] || []), { txid: id, vout: 0, value: out.amount, confirmations: 6 }];
        return id;
      },
    },
  };
  const pay = makePayments({
    DATA: dir, read, write, log: (l) => logs.push(l), alert: (k, t) => alerts.push([k, t]),
    tooMany: () => false, chains, ltcRate: async () => ltcRate, live: false,
    onOrder: (id, view) => pushes.push([id, view.status]),
    credit: (user, plan) => { credits.push([user, plan]); return ''; },
  });
  return { dir, pay, chain, logs, alerts, credits, pushes, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const order = (pay, coin, plan = 'week', usd = 2) => pay.createOrder({ user: '111', userName: 'Buyer', plan, planName: plan === 'week' ? '7 days' : '30 days', coin, usd });

test('amounts are kept exact', () => {
  assert.equal(toBase('2', 18), 2n * USDT);
  assert.equal(toBase('2.5', 18), 25n * 10n ** 17n);
  assert.equal(toBase('0.02353', 8), 2353000n);
  assert.equal(fromBase(2353000n, 8), '0.02353');
  assert.equal(fromBase(2n * USDT, 18, 2), '2');
  assert.equal(fromBase(123456789n * 10n ** 10n, 18, 2), '1.23');
  assert.throws(() => toBase('-1', 8));
  assert.throws(() => toBase('1e5', 8));
});

test('the wallet: one seed, the published addresses, and it is never replaced', () => {
  const t = setup();
  try {
    assert.equal(t.pay.wallet(), false);
    assert.throws(() => t.pay.importWallet('not a seed at all'), /not a valid seed/);
    t.pay.importWallet(SEED);
    // m/44'/60'/0'/0/0 and /1 of this seed are Hardhat's first two accounts
    assert.equal(t.pay.keyAt('usdt_bsc', 0).address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    assert.equal(t.pay.keyAt('usdt_bsc', 1).address, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const col = t.pay.collectors();
    assert.match(col.usdt_bsc, /^0x[0-9a-fA-F]{40}$/);
    assert.match(col.ltc, /^ltc1q[0-9a-z]{38}$/, 'a native segwit Litecoin address');
    assert.doesNotThrow(() => btc.Address(LTC_NET).decode(col.ltc));
    assert.notEqual(t.pay.keyAt('ltc', 1).address, t.pay.keyAt('ltc', 2).address, 'each order its own address');
    assert.throws(() => t.pay.createWallet(), /already exists/, 'a wallet is never replaced');
    assert.throws(() => t.pay.importWallet(SEED), /already exists/);
  } finally { t.done(); }
});

test('a new wallet is 24 words, and the seed is shown only by createWallet', () => {
  const t = setup();
  try {
    const made = t.pay.createWallet();
    assert.equal(made.mnemonic.split(' ').length, 24);
    assert.ok(made.collectors.usdt_bsc && made.collectors.ltc);
    assert.ok(!JSON.stringify(t.pay.list()).includes(made.mnemonic.split(' ')[0] + ' ' + made.mnemonic.split(' ')[1]), 'the orders never carry it');
  } finally { t.done(); }
});

test('addresses: only real BSC and Litecoin addresses are accepted as main addresses', () => {
  const t = setup();
  try {
    assert.equal(t.pay.validAddress('usdt_bsc', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'), true);
    assert.equal(t.pay.validAddress('usdt_bsc', '0x70997970C51812dc3A010C7d01b50e0d17dc79C9'), false, 'a wrong checksum');
    assert.equal(t.pay.validAddress('usdt_bsc', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'), false, 'a TRON address is not BSC');
    assert.equal(t.pay.validAddress('ltc', 'ltc1qg82tpjryqncsj9pj2fe5d2wcdpw4uqhd8n4qu4'), false, 'a bad checksum');
    t.pay.importWallet(SEED);
    assert.equal(t.pay.validAddress('ltc', t.pay.keyAt('ltc', 7).address), true);
    assert.equal(t.pay.validAddress('ltc', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false, 'a Bitcoin address is not Litecoin');
    assert.throws(() => t.pay.saveSettings({ payout: { usdt_bsc: 'nope' } }), /not a BNB Smart Chain/);
    assert.throws(() => t.pay.saveSettings({ confirmations: { ltc: 0 } }), /from 1 to 100/);
    assert.throws(() => t.pay.saveSettings({ bsc_rpc: 'http://x' }), /https/);
    const saved = t.pay.saveSettings({ payout: { usdt_bsc: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' } });
    assert.deepEqual(saved.payoutChanged, ['usdt_bsc']);
  } finally { t.done(); }
});

test('USDT: waiting, seen, paid once, the time added, the money moved with gas from the collector, and cashed out', async () => {
  const t = setup();
  try {
    await assert.rejects(order(t.pay, 'usdt_bsc'), /not set up/);
    t.pay.importWallet(SEED);
    const o = await order(t.pay, 'usdt_bsc');
    assert.equal(o.amount, '2');
    assert.equal(o.symbol, 'USDT');
    assert.match(o.qr, /^<svg/);
    assert.equal((await order(t.pay, 'usdt_bsc')).address, o.address, 'the same order again gives the same address');
    assert.notEqual((await order(t.pay, 'usdt_bsc', 'month', 6)).address, o.address, 'another plan, another address');

    await t.pay.tick();
    assert.equal((await t.pay.orderFor('111', o.id)).status, 'waiting');
    assert.equal(await t.pay.orderFor('222', o.id), null, "nobody else's order");

    t.chain.tok[o.address] = { pending: 2n * USDT, confirmed: 0n };              // sent, not confirmed yet
    await t.pay.tick();
    assert.equal((await t.pay.orderFor('111', o.id)).status, 'seen');
    assert.equal(t.credits.length, 0, 'no time before the confirmations');

    const col = t.pay.collectors().usdt_bsc;
    t.chain.native[col] = 10n ** 16n;                                             // 0.01 BNB for gas
    t.chain.tok[o.address] = { pending: 2n * USDT, confirmed: 2n * USDT };
    await t.pay.tick();
    assert.equal((await t.pay.orderFor('111', o.id)).status, 'paid');
    assert.deepEqual(t.credits, [['111', 'week']], 'the plan is added, once');
    const gas = t.chain.sent.find((s) => s.kind === 'bnb');
    assert.equal(gas.to, o.address, 'the collector paid the gas of the deposit address');
    assert.equal(gas.value, (50_000n * 13n / 10n) * 1_000_000_000n, 'just enough for one token transfer');
    const moved = t.chain.sent.find((s) => s.kind === 'usdt');
    assert.deepEqual([moved.from, moved.to, moved.amount], [o.address, col, 2n * USDT], 'the USDT went to the collector');
    assert.equal(t.pay.list().orders.find((x) => x.id === o.id).swept, true);

    await t.pay.tick();
    assert.equal(t.credits.length, 1, 'never twice');

    // cash-out: by hand, to the main address
    await assert.rejects(t.pay.cashOut('usdt_bsc'), /main USDT address/);
    const main = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    t.pay.saveSettings({ payout: { usdt_bsc: main } });
    const out = await t.pay.cashOut('usdt_bsc');
    assert.deepEqual([out.amount, out.to], ['2', main]);
    assert.equal(t.chain.tok[main].confirmed, 2n * USDT);
    assert.equal(t.pay.list().cashouts.length, 1);
    assert.equal(await t.pay.cashOut('usdt_bsc'), null, 'nothing left: nothing sent');
  } finally { t.done(); }
});

test('USDT: auto cash-out waits for the minimum, and a collector without BNB is reported, not lost', async () => {
  const t = setup();
  try {
    t.pay.importWallet(SEED);
    const main = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    t.pay.saveSettings({ payout: { usdt_bsc: main }, auto: { usdt_bsc: true }, min_cashout: { usdt_bsc: 5 } });
    const o = await order(t.pay, 'usdt_bsc');
    t.chain.tok[o.address] = { confirmed: 2n * USDT };
    await t.pay.tick();                                                           // paid, but the collector has no BNB
    const row = t.pay.list().orders.find((x) => x.id === o.id);
    assert.equal(row.status, 'paid', 'the buyer gets the time whatever happens to the gas');
    assert.equal(row.swept, false);
    assert.match(row.sweep_error, /no BNB left for gas/);
    assert.ok(t.alerts.some(([k]) => k === 'sweep'), 'the admin is told');

    const col = t.pay.collectors().usdt_bsc;
    t.chain.native[col] = 10n ** 16n;
    t.pay.retrySweep(o.id);
    await t.pay.tick();
    assert.equal(t.pay.list().orders.find((x) => x.id === o.id).swept, true);
    assert.equal(t.chain.tok[main], undefined, '2 USDT is under the 5 USDT minimum: no auto cash-out yet');

    const o2 = await order(t.pay, 'usdt_bsc', 'month', 6);
    t.chain.tok[o2.address] = { confirmed: 6n * USDT };
    await t.pay.tick();
    assert.equal(t.chain.tok[main].confirmed, 8n * USDT, 'past the minimum: everything goes out by itself');
  } finally { t.done(); }
});

test('LTC: the rate of the moment, partial payments, a real signed sweep, and cash-out', async () => {
  const t = setup({ ltcRate: 100 });
  try {
    t.pay.importWallet(SEED);
    const o = await order(t.pay, 'ltc');                                          // $2 at $100 = 0.02 LTC
    assert.equal(o.amount, '0.02');
    assert.match(o.address, /^ltc1q/);
    assert.match(o.qr, /^<svg/);

    t.chain.utxos[o.address] = [{ txid: '11'.repeat(32), vout: 0, value: 1_000_000n, confirmations: 3 }];
    await t.pay.tick();
    assert.equal((await t.pay.orderFor('111', o.id)).status, 'partial', 'half was sent');
    assert.equal(t.credits.length, 0);

    t.chain.utxos[o.address].push({ txid: '22'.repeat(32), vout: 1, value: 990_000n, confirmations: 0 });
    await t.pay.tick();
    assert.equal(t.credits.length, 0, 'the rest is not confirmed yet');
    t.chain.utxos[o.address][1].confirmations = 2;
    await t.pay.tick();                                                           // 0.0199 LTC: within 1 %
    assert.equal((await t.pay.orderFor('111', o.id)).status, 'paid');
    assert.deepEqual(t.credits, [['111', 'week']]);

    const col = t.pay.collectors().ltc;
    const sweep = t.chain.broadcasts[0];
    assert.equal(sweep.to, col, 'swept to the collector');
    assert.equal(sweep.inputs, 2, 'both payments, in one transaction');
    assert.equal(sweep.amount, 1_990_000n - 10n * (11n + 68n * 2n + 34n), 'less the network fee');

    const main = t.pay.keyAt('ltc', 999).address;                                // a valid Litecoin address, made for the test
    t.pay.saveSettings({ payout: { ltc: main } });
    const out = await t.pay.cashOut('ltc');
    assert.equal(out.to, main);
    assert.equal(t.chain.broadcasts[1].to, main, 'a real signed transaction to the main address');
    assert.equal(t.chain.broadcasts[1].amount, sweep.amount - 10n * (11n + 68n + 34n));
  } finally { t.done(); }
});

test('money that comes after the time to pay still counts; an unpaid order closes after a day', async () => {
  const t = setup();
  try {
    t.pay.importWallet(SEED);
    const o = await order(t.pay, 'usdt_bsc');
    const file = join(t.dir, 'payments.json');
    const db = JSON.parse(readFileSync(file, 'utf8'));
    db.orders[o.id].expires = Date.now() - 1000;                                // the hour to pay is over
    writeFileSync(file, JSON.stringify(db));
    assert.equal((await t.pay.orderFor('111', o.id)).status, 'expired', 'the page says so');
    t.chain.native[t.pay.collectors().usdt_bsc] = 10n ** 16n;
    t.chain.tok[o.address] = { confirmed: 2n * USDT };
    await t.pay.tick();
    assert.equal((await t.pay.orderFor('111', o.id)).status, 'paid', 'but the money is not lost: the time is added');

    const late = await order(t.pay, 'usdt_bsc', 'month', 6);
    const db2 = JSON.parse(readFileSync(file, 'utf8'));
    db2.orders[late.id].created = Date.now() - 25 * 3600 * 1000;
    writeFileSync(file, JSON.stringify(db2));
    await t.pay.tick();
    assert.equal(t.pay.list().orders.find((x) => x.id === late.id).status, 'expired');
  } finally { t.done(); }
});

test('the admin can credit an underpaid order by hand, once', async () => {
  const t = setup();
  try {
    t.pay.importWallet(SEED);
    const o = await order(t.pay, 'usdt_bsc');
    t.chain.tok[o.address] = { confirmed: USDT };                                 // 1 of 2 USDT
    await t.pay.tick();
    assert.equal(t.pay.list().orders.find((x) => x.id === o.id).status, 'partial');
    const done = t.pay.credit(o.id, 'admin');
    assert.equal(done.status, 'paid');
    assert.equal(done.paid_how, 'admin');
    assert.equal(t.pay.credit(o.id, 'admin'), null, 'not twice');
    assert.deepEqual(t.credits, [['111', 'week']]);
  } finally { t.done(); }
});

test('three open payments at most, and only the coins that are switched on', async () => {
  const t = setup();
  try {
    t.pay.importWallet(SEED);
    await order(t.pay, 'usdt_bsc', 'week', 2);
    await order(t.pay, 'usdt_bsc', 'month', 6);
    await order(t.pay, 'ltc', 'week', 2);
    await assert.rejects(order(t.pay, 'ltc', 'month', 6), /3 payments open/);
    t.pay.saveSettings({ enabled: { ltc: false } });
    await assert.rejects(t.pay.createOrder({ user: '9', plan: 'week', planName: '7 days', coin: 'ltc', usd: 2 }), /not available/);
    await assert.rejects(t.pay.createOrder({ user: '9', plan: 'week', planName: '7 days', coin: 'doge', usd: 2 }), /not available/);
    await assert.rejects(t.pay.createOrder({ user: '9', plan: 'week', planName: '7 days', coin: 'usdt_bsc', usd: 0 }), /no price/);
  } finally { t.done(); }
});

test('the buyer\'s page is told every change of its order (seen, paid), and a kick looks at once', async () => {
  const t = setup();
  try {
    t.pay.importWallet(SEED);
    const o = await order(t.pay, 'usdt_bsc');
    await t.pay.tick();
    assert.deepEqual(t.pushes, [], 'nothing changed: nothing said');
    t.chain.tok[o.address] = { pending: 2n * USDT, confirmed: 0n };
    await t.pay.kick(o.id);                                                       // what a blockchain socket does
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(t.pushes, [[o.id, 'seen']], 'seen, the moment it was looked at');
    t.chain.native[t.pay.collectors().usdt_bsc] = 10n ** 16n;
    t.chain.tok[o.address] = { pending: 2n * USDT, confirmed: 2n * USDT };
    await t.pay.kick(o.id);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(t.pushes.map((p) => p[1]), ['seen', 'paid']);
    assert.deepEqual(t.credits, [['111', 'week']]);
    await t.pay.kick(o.id);
    assert.equal(t.credits.length, 1, 'a kick after it is paid does nothing');
  } finally { t.done(); }
});
