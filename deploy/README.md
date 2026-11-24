# Grape's server on a VPS, with automatic deploys

You push to GitHub; within a minute the VPS has tested, built and started the new version. Nothing on your own computer has
to be running, and GitHub holds no secrets.

```
you push -> GitHub (public repo) <- the VPS asks every minute (grape-pull.timer)
                                      |  new commit? clone -> npm ci -> npm test -> npm run build   in /opt/grape-build
                                      |  all passed?  copy to /opt/grape-server, restart, check /v1/health
internet -> Caddy (https, :443) -> the server (127.0.0.1:8787)
```

A commit that fails its tests or its build is **not deployed**: the server keeps running the last good version, and that commit is
not tried again until there is a newer one. Look at `journalctl -u grape-pull -n 40`.

Two kinds of files reach the VPS in two different ways:

| What | Built where | How it gets there |
|---|---|---|
| The server's **code** and the built website | the VPS | automatically, from GitHub |
| **Grape.exe, the installer, the agent, the window bundle** | your Windows computer | `scripts\publish-payload.ps1`, when you release a new build |

## One-time setup

1. **Domain:** an A record `grapeclient.com -> the VPS's IP` (done).
2. **A key for uploading the payload** (PowerShell): `ssh-keygen -t ed25519 -f $HOME\.ssh\grape-deploy -C grape-deploy -N '""'`.
   The `.pub` file goes to the VPS in step 3; the private file stays on your computer.
3. **Set up the VPS** (as root, with this `deploy` folder copied there):
   ```bash
   DOMAIN=grapeclient.com REPO=https://github.com/Grape-Client/GrapeClientWebsite.git \
   DEPLOY_PUBKEY="ssh-ed25519 AAAA... grape-deploy" bash setup-vps.sh
   ```
   It installs Node 24 and Caddy, makes two users (`grape` runs the server and writes only its data; `deploy` builds new versions and,
   as root, may only restart the server), adds a little swap, opens only SSH, 80 and 443, sets up https and the deployer.
4. **Move the data** (accounts, keys, admin password, the resource key). Locally:
   ```powershell
   cd D:\DonutClient\server
   $env:GRAPE_BACKUP_PASSWORD = 'a long password'
   node server.js backup $HOME\grape.grapebak
   scp -i $HOME\.ssh\grape-deploy $HOME\grape.grapebak deploy@grapeclient.com:/tmp/
   ```
   On the VPS (as root): `sudo -u grape env GRAPE_DATA=/var/lib/grape-server GRAPE_BACKUP_PASSWORD='the same' node /opt/grape-build/server.js restore /tmp/grape.grapebak --force`
   (after the first deploy has made `/opt/grape-build/node_modules` - or use `/opt/grape-server/server.js`), then `shred -u /tmp/grape.grapebak`.
5. **Start deploying:** `systemctl start grape-pull.timer`. The first run takes a few minutes.
6. **Discord:** in the Developer Portal > OAuth2 > Redirects add `https://grapeclient.com/v1/discord/callback`. Settings > Discord on
   `https://grapeclient.com/admin-grape` takes the client id and secret.
7. **The app:** it only talks to the address it was built with: `npm run release` (in the app's folder) builds for
   `https://grapeclient.com`. Then `.\sync-payload.ps1` and `.\scripts\publish-payload.ps1 -Target deploy@grapeclient.com`.

## Day to day

- **Change the server:** edit, `git push`. That is all.
- **New Grape build:** `npm run release` in the app, `.\sync-payload.ps1`, `.\scripts\publish-payload.ps1 -Target deploy@grapeclient.com`.
  Raise "Oldest Version" in Settings > Security when an old build must stop working.
- **Backups:** daily from cron on the VPS, copied off the machine:
  `GRAPE_BACKUP_PASSWORD=... node /opt/grape-server/server.js backup /root/grape-$(date +%F).grapebak`. Try a restore once.
- **Logs:** `journalctl -u grape-server -f`, `journalctl -u grape-pull -n 40`, and the admin page's Server Log.
- **Rolling back:** revert the commit and push. A deploy never changes `data/`.
- **If the repository becomes private:** the VPS needs read access: `ssh-keygen -t ed25519 -f /home/deploy/.ssh/github -N ''` as `deploy`,
  add its `.pub` as a read-only deploy key (repo > Settings > Deploy keys), and set the clone's remote to `git@github.com:Grape-Client/GrapeClientWebsite.git`.

## What protects it

Only 22, 80 and 443 are open; the server listens on `127.0.0.1` only; it runs as a user that cannot log in, with a read-only view of
the code and write access to its data only (the systemd sandbox in `grape-server.service`); new versions are built away from the
running one, and only after their tests pass; the repository never holds the data. **Turn off password logins for SSH once your key
works** (`PasswordAuthentication no` in `/etc/ssh/sshd_config.d/`) and change any password that was ever typed into a chat.
Secrets that were ever in a chat, a screenshot or a commit are burned: the Discord client secret (reset it in the portal), the admin
password, `session.key` (delete it on the VPS: everyone is signed out), and the resource key (changing it means rebuilding the app).

## Pinning the certificate (optional)

Without it the app trusts https as Windows does, like a browser. With it (`node scripts\pin.mjs grapeclient.com`, then
`$env:GRAPE_PINS = '<pin>'` before the build) it accepts only your key. The pin is the hash of the certificate's key, and Caddy may
make a new key when it renews (about every 60 days): apps built with the old pin then stop connecting. Use it only with a
certificate whose key you keep, and pin a spare key as well. Start without it.
