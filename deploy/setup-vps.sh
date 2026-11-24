#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu/Debian VPS for Grape's server. Safe to run again.
#
#   DOMAIN=grape.example.com DEPLOY_PUBKEY="ssh-ed25519 AAAA... github-deploy" sudo -E bash setup-vps.sh
#
#   DOMAIN         the domain whose DNS already points at this machine (Caddy gets its certificate)
#   DEPLOY_PUBKEY  the PUBLIC half of the key GitHub Actions deploys with (README, step 4)
#
# What it makes:
#   user "grape"   runs the server; cannot log in; can read the code, write only its data
#   user "deploy"  what GitHub logs in as; owns the code; may restart the server and do nothing else as root
#   /opt/grape-server        the code (put there by the workflow)        /var/lib/grape-server   the data (never touched by it)
#   Caddy on 80/443 -> the server on 127.0.0.1:8787;  ufw: only SSH, 80 and 443 are open
set -euo pipefail

: "${DOMAIN:?set DOMAIN=your.domain}"
: "${DEPLOY_PUBKEY:?set DEPLOY_PUBKEY=\"ssh-ed25519 AAAA...\"}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo -E bash setup-vps.sh)"; exit 1; }
case "$DEPLOY_PUBKEY" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;; *) echo "DEPLOY_PUBKEY must be a public key (ssh-ed25519 AAAA...)"; exit 1;; esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https

# Node 24 (what the code is built and tested with)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

# Caddy: https with a certificate it gets and renews by itself
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# the two users
id grape >/dev/null 2>&1 || useradd --system --home /opt/grape-server --shell /usr/sbin/nologin grape
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
grep -qxF "$DEPLOY_PUBKEY" /home/deploy/.ssh/authorized_keys || echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys

# the folders: the code is the deploy user's and only readable by the server; the data is the server's alone
install -d -m 755 -o deploy -g deploy /opt/grape-server /opt/grape-server/payload
install -d -m 2775 -o grape -g deploy /opt/grape-server/.next /opt/grape-server/.next/cache   # Next.js writes its cache there
install -d -m 700 -o grape -g grape /var/lib/grape-server

# the service
install -m 644 "$(dirname "$0")/grape-server.service" /etc/systemd/system/grape-server.service
sed -i "s#^Environment=GRAPE_PUBLIC_URL=.*#Environment=GRAPE_PUBLIC_URL=https://${DOMAIN}#" /etc/systemd/system/grape-server.service
sed -i 's#^ReadWritePaths=.*#ReadWritePaths=/var/lib/grape-server /opt/grape-server/.next/cache#' /etc/systemd/system/grape-server.service
[ -f /etc/grape-server.env ] || { install -m 600 -o root -g root /dev/null /etc/grape-server.env; echo "# secrets for the server, one per line:  GRAPE_DISCORD_CLIENT_SECRET=..." > /etc/grape-server.env; }
systemctl daemon-reload
systemctl enable grape-server >/dev/null

# the deploy user may restart the server, and nothing else as root
cat > /etc/sudoers.d/grape-deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart grape-server, /usr/bin/systemctl is-active grape-server
EOF
chmod 440 /etc/sudoers.d/grape-deploy
visudo -cf /etc/sudoers.d/grape-deploy >/dev/null

# Caddy
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
	reverse_proxy 127.0.0.1:8787
}
EOF
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# the firewall: SSH, http, https
ufw allow OpenSSH >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw --force enable >/dev/null

echo
echo "Ready for the first deploy. Next: push the server code to GitHub (the workflow puts it here), then"
echo "  node server.js admin-password '<long password>'   (as: sudo -u grape env GRAPE_DATA=/var/lib/grape-server node /opt/grape-server/server.js ...)"
echo "Open https://${DOMAIN}/v1/health once the workflow has run."
