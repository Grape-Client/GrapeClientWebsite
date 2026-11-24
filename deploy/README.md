# Putting Grape's server on a VPS, with automatic deploys

What you end up with: you push to GitHub, and a minute later the new server is live on your domain. Nothing on your
own computer has to be running.

```
you push -> GitHub Actions: test, build -> rsync over SSH -> VPS: restart -> health check
                                                               |
                       internet -> Caddy (https, :443) -> the server (127.0.0.1:8787)
```

Two kinds of files go to the VPS in two different ways:

| What | Built where | How it gets there |
|---|---|---|
| The server's **code** and the built website | GitHub (the workflow) | automatically, on every push to `main` |
| **Grape.exe, the installer, the agent, the window bundle** | your Windows computer | `scripts\publish-payload.ps1`, when you release a new build |

## 1. Get a VPS and a domain

- Any Linux VPS with Ubuntu 22.04/24.04 or Debian 12 and 1 GB of RAM is enough (Hetzner, DigitalOcean, Vultr...).
- Point a domain at it: an **A record** `grape.example.com -> the VPS's IP`. If the domain is on Cloudflare, set the record to
  **DNS only** (grey cloud) so Caddy can get its certificate. (You can turn the orange cloud on later: Cloudflare then sits in
  front of the same server, with SSL mode "Full (strict)". Do not do that if you pin certificates, step 8.)

## 2. Make the deploy key (on your computer)

GitHub needs its own key to log in to the VPS. In PowerShell:

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\grape-deploy -C github-deploy -N '""'
Get-Content $HOME\.ssh\grape-deploy.pub     # the PUBLIC half: goes on the VPS (step 3)
Get-Content $HOME\.ssh\grape-deploy         # the PRIVATE half: goes into GitHub (step 5), nowhere else
```

## 3. Set up the VPS, once

Log in as root (`ssh root@<ip>`), copy this `deploy` folder there (`scp -r deploy root@<ip>:/root/`), then:

```bash
cd /root/deploy
DOMAIN=grape.example.com DEPLOY_PUBKEY="ssh-ed25519 AAAA...your public key... github-deploy" sudo -E bash setup-vps.sh
```

It installs Node 24 and Caddy, makes two users (`grape` runs the server and can only write its data; `deploy` is what GitHub
logs in as, and as root it may only restart the server), starts the firewall with only SSH, 80 and 443 open, and sets up https for
your domain. Running it again is safe.

## 4. Put the server code on GitHub (a private repository)

In `D:\DonutClient\server`:

```powershell
git add -A
git commit -m "Grape server"
gh repo create grape-server --private --source . --push     # or create it on github.com and add it as origin
```

`.gitignore` keeps `data/`, `payload/`, `node_modules/` and `.next/` out: **accounts, keys and secrets never go to GitHub.**

## 5. Give GitHub its secrets

Repository > Settings > Secrets and variables > Actions > New repository secret:

| Secret | Value |
|---|---|
| `VPS_HOST` | the VPS's IP or name |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | the whole PRIVATE key file from step 2, including the `-----BEGIN` and `-----END` lines |
| `VPS_KNOWN_HOSTS` | the output of `ssh-keyscan -t ed25519 <the VPS's IP>`: GitHub then talks to your machine, not to someone pretending to be it |
| `PUBLIC_URL` | `https://grape.example.com` |
| `VPS_PORT` | only if SSH is not on 22 |

## 6. First deploy

Push to `main` (or Actions > Deploy > Run workflow). The steps are Test, Build, Upload, Install and restart, Check that it
answers. When the last one prints `up`, open `https://grape.example.com/v1/health`.

If a step goes red it says where. On the VPS: `journalctl -u grape-server -n 50`.

## 7. Move your data and the payload to the VPS

Your accounts, keys, admin password and the resource key are in `D:\DonutClient\server\data`. Move them as an encrypted backup:

```powershell
cd D:\DonutClient\server
$env:GRAPE_BACKUP_PASSWORD = 'a long password you will not forget'
node server.js backup $HOME\grape.grapebak
scp $HOME\grape.grapebak deploy@grape.example.com:/tmp/
```

On the VPS (as root):

```bash
systemctl stop grape-server
sudo -u grape env GRAPE_DATA=/var/lib/grape-server GRAPE_BACKUP_PASSWORD='the same password' node /opt/grape-server/server.js restore /tmp/grape.grapebak --force
shred -u /tmp/grape.grapebak
systemctl start grape-server
```

Then send the payload (build the app first: `npm run build` in `D:\Grape`, then `.\sync-payload.ps1`):

```powershell
.\scripts\publish-payload.ps1 -Target deploy@grape.example.com
```

## 8. Point everything at the real address

1. **Discord Developer Portal** > your application > OAuth2 > Redirects: add `https://grape.example.com/v1/discord/callback`.
   Then in `https://grape.example.com/admin-grape` > Settings > Discord: the client id, the secret and the public address.
2. **Build the app for this server.** It only ever talks to the address it was built with:
   ```powershell
   $env:GRAPE_SERVER = 'https://grape.example.com'
   npm run build                                         # in D:\Grape
   .\sync-payload.ps1; .\scripts\publish-payload.ps1 -Target deploy@grape.example.com
   ```
   People download the installer from the website: it must be this new one.
3. Admin page > Settings > Security: the addresses allowed to open the admin page, and the alert webhook.

**Certificate pinning is optional.** Without it the app trusts https as Windows does, which is what browsers do too. With it
(`node scripts\pin.mjs grape.example.com`, then `$env:GRAPE_PINS = '<pin>'` before the build) the app accepts only your key, but
the pin is the hash of the certificate's *key*, and Caddy may make a new key when it renews (about every 60 days): programs built
with the old pin then stop connecting. Use pinning only if you give Caddy a certificate whose key you keep (`tls /path/cert.pem /path/key.pem`,
made with `certbot --reuse-key`), and pin a spare key as well as the current one (`GRAPE_PINS=<pin1>,<pin2>`). Start without it.

## Day to day

- **Change the server:** edit, `git push`. That is all.
- **New Grape build:** `npm run build` in `D:\Grape`, `.\sync-payload.ps1`, `.\scripts\publish-payload.ps1 -Target deploy@...`.
  Raise "Oldest Version" in Settings > Security when an old build must stop working.
- **Backups:** daily from cron on the VPS, copied off the machine:
  `GRAPE_BACKUP_PASSWORD=... node /opt/grape-server/server.js backup /root/grape-$(date +%F).grapebak`. Try a restore once.
- **Logs:** `journalctl -u grape-server -f`, and the admin page's Server Log.
- **Rolling back:** revert the commit and push; the workflow deploys the older code. A deploy never changes `data/`.

## What protects it

Only 22, 80 and 443 are open; the server listens on `127.0.0.1` only; it runs as a user that cannot log in, with a read-only view
of the code and write access to its data only (the systemd sandbox in `grape-server.service`); GitHub reaches the VPS with a key
that can only restart the server, and checks the VPS's host key; the repository never holds the data. Secrets that were ever in a
chat, a screenshot or a commit are burned: the Discord client secret (reset it in the portal), the admin password, `session.key`
(delete it on the VPS: everyone is signed out), and the resource key (changing it means rebuilding the app).
