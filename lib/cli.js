// The admin commands: `node server.js <command>`. The same operations the admin page uses (lib/core.js `ops`).
//
//   plans                                 the plans and their lengths
//   genkey <plan> [n] [note]              make n redeemable keys (shown once; the server keeps only their hashes)
//   keys                                  the keys made, and which are used
//   revoke-key <prefix>                   cancel an unused key (its hash prefix, from "keys")
//   accounts                              the registered computers, and the Discord user each is logged in as
//   users                                 the Discord users: plan, time left, the computer they are locked to
//   grant <id> <plan>                     give a user a plan, as if they had redeemed a key
//   extend <id> <days>                    add days (a negative number takes them away)
//   revoke <id> | unrevoke <id>           switch a user off / on
//   reset <id>                            free a user's HWID lock now (no 24-hour wait): the next computer takes it
//   link <computer> <discord id> [name]   log a computer in as a Discord user by hand (support, tests)
//   unlink <computer>                     log a computer out
//   admin-password <password>             set the admin page's password (signs everyone out of it)
//   installer [hours] [note]              make an installer that works once: prints its download link (shown once)
//   installers                            the installers made, and which are used
//   revoke-installer <id>                 cancel an installer that was not used
//   backup <file>                         an encrypted copy of the data folder (password: GRAPE_BACKUP_PASSWORD)
//   restore <file> [--force]              put a backup back (stop the server first)
//   <id> is a Discord user id, or a computer's id (then the user it is logged in as).
'use strict';

module.exports = function cli(core, command, args) {
  const { ops } = core;
  const when = (ms) => (ms === null ? 'never' : ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-');
  const fail = (text) => { console.error(text); process.exit(1); };
  const run = (work) => { try { return work(); } catch (e) { return fail(e.message || String(e)); } };

  switch (command) {
    case 'plans':
      for (const p of ops.plans()) console.log(`${p.id.padEnd(10)} ${p.name.padEnd(12)} ${p.days === null ? 'forever' : p.days + ' days'}`);
      return true;
    case 'genkey': {
      const n = parseInt(args[1], 10);
      const note = args.slice(n ? 2 : 1).join(' ');
      const made = run(() => ops.makeKeys(args[0], n || 1, note));
      const plan = ops.plans().find((p) => p.id === args[0]);
      console.log(`${made.length} ${plan.name} key${made.length === 1 ? '' : 's'}${note ? ' (' + note + ')' : ''}:\n`);
      for (const k of made) console.log('  ' + k);
      console.log('\nShown once: the server keeps only their hashes.');
      return true;
    }
    case 'keys': {
      const list = ops.keys();
      if (!list.length) console.log('No keys yet. Make some with: node server.js genkey <plan> [n]');
      for (const k of list) console.log(`${k.hash.slice(0, 8)}  ${k.plan.padEnd(9)} ${k.revoked ? 'CANCELLED' : k.used_by ? 'used by ' + k.used_by + ' ' + when(k.used_at) : 'unused'}${k.note ? '  ' + k.note : ''}`);
      return true;
    }
    case 'revoke-key':
      run(() => ops.cancelKey(args[0]));
      console.log('Cancelled.');
      return true;
    case 'accounts':
    case 'list': {
      const list = ops.computers();
      if (!list.length) console.log('No computers yet: a computer registers when Grape first talks to the server.');
      for (const c of list) console.log(`${c.id}  ${c.revoked ? 'OFF  ' : '     '}pc ${c.hwid || '-'.padEnd(13)}  ${c.user ? c.user + ' ' + c.user_name : c.old_plan ? 'not logged in, has old ' + c.old_plan + ' time' : 'not logged in'}`);
      return true;
    }
    case 'users': {
      const list = ops.users();
      if (!list.length) console.log('No Discord users yet: one is made when someone logs in with Discord.');
      for (const u of list) {
        const state = u.revoked ? 'OFF     ' : u.active ? 'active  ' : u.plan ? 'expired ' : 'no plan ';
        console.log(`${u.id.padEnd(20)} ${u.username.padEnd(20)} ${state} ${String(u.plan || '-').padEnd(9)} until ${when(u.expires).padEnd(24)} uses ${String(u.uses).padEnd(4)} ${u.hwid ? 'locked to pc ' + u.hwid : 'not locked'}  (${u.computers.length} computer${u.computers.length === 1 ? '' : 's'} logged in, last reset ${when(u.hwid_reset_at)})`);
      }
      return true;
    }
    case 'link':
      run(() => ops.link(args[0], args[1], args.slice(2).join(' ')));
      console.log('Logged in.');
      return true;
    case 'unlink':
      run(() => ops.unlink(args[0]));
      console.log('Logged out.');
      return true;
    case 'grant': {
      const u = run(() => ops.user(args[0], 'grant', args[1]));
      console.log(`Granted: now until ${when(u.expires)}.`);
      return true;
    }
    case 'extend': {
      const u = run(() => ops.user(args[0], 'extend', args[1]));
      console.log(`Now until ${when(u.expires)}.`);
      return true;
    }
    case 'revoke':
    case 'unrevoke':
      run(() => ops.user(args[0], command));
      console.log(command === 'revoke' ? 'Switched off.' : 'Switched on.');
      return true;
    case 'reset':
      run(() => ops.user(args[0], 'reset-hwid'));
      console.log('The lock is free: the next computer logged in as this user that uses Grape takes it.');
      return true;
    case 'installer': {
      const hours = /^\d+$/.test(args[0] || '') ? args[0] : undefined;
      const made = run(() => ops.makeInstaller(args.slice(hours ? 1 : 0).join(' '), hours));
      console.log(`Installer ${made.id}, good for its first start until ${when(made.expires)}:\n\n  ${made.url}\n\nShown once: the server keeps only a hash. It works once, on one computer.`);
      return true;
    }
    case 'installers': {
      const list = ops.installers();
      if (!list.length) console.log('No installers yet. Make one with: node server.js installer [hours] [note]');
      for (const i of list) console.log(`${i.id}  ${i.state.padEnd(8)} made ${when(i.made)}  ${i.by === 'admin' ? '' : 'for ' + i.by + '  '}${i.state === 'used' ? 'used ' + when(i.used_at) + ' on ' + i.computer : i.state === 'claimed' ? 'started on ' + i.computer + ' (try ' + i.tries + ')' : i.state === 'issued' ? 'until ' + when(i.expires) : ''}${i.note ? '  ' + i.note : ''}`);
      return true;
    }
    case 'revoke-installer':
      run(() => ops.revokeInstaller(args[0]));
      console.log('Cancelled.');
      return true;
    case 'backup': {
      if (!args[0]) fail('Usage: GRAPE_BACKUP_PASSWORD=... node server.js backup <file>');
      const n = run(() => require('./backup').backup(core.DATA, args[0], process.env.GRAPE_BACKUP_PASSWORD));
      console.log(`${n} files saved to ${args[0]}, encrypted. Keep the password somewhere else than the backup.`);
      return true;
    }
    case 'restore': {
      if (!args[0]) fail('Usage: GRAPE_BACKUP_PASSWORD=... node server.js restore <file> [--force]');
      const n = run(() => require('./backup').restore(core.DATA, args[0], process.env.GRAPE_BACKUP_PASSWORD, args.includes('--force')));
      console.log(`${n} files restored into ${core.DATA}.`);
      return true;
    }
    case 'admin-password': {
      const problem = core.setAdminPasswordFromCli(args.join(' '));
      if (problem) fail(problem);
      console.log('The admin password is set. Sign in at /admin-grape.');
      return true;
    }
    default:
      return false;
  }
};
