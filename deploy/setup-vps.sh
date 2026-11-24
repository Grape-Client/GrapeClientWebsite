#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu/Debian VPS for Grape's server, with automatic deploys from GitHub. Safe to run again.
#
#   DOMAIN=grapeclient.com REPO=https://github.com/Grape-Client/GrapeClientWebsite.git \
#   DEPLOY_PUBKEY="ssh-ed25519 AAAA... grape-deploy" bash setup-vps.sh        (as root)
#
#   DOMAIN         the domain whose DNS already points at this machine (Caddy gets its certificate)
#   REPO           the public git address of the server code
#   DEPLOY_PUBKEY  the PUBLIC half of the key that uploads Grape.exe & co. (scripts\publish-payload.ps1) as user "deploy"
#
# What it makes:
#   user "grape"   runs the server; cannot log in; can read the code, write only its data
#   user "deploy"  builds new versions (grape-pull.timer, every minute) and takes the payload upload; as root it may only restart the server
#   /opt/grape-build   a clone of the repo where new versions are tested and built
#   /opt/grape-server  what runs (copied from the build)       /var/lib/grape-server  the data (a deploy never touches it)
#   Caddy on 80/443 -> the server on 127.0.0.1:8787;  ufw: only SSH, 80 and 443 are open
set -euo pipefail

: "${DOMAIN:?set DOMAIN=your.domain}"
: "${REPO:?set REPO=https://github.com/.../....git}"
: "${DEPLOY_PUBKEY:?set DEPLOY_PUBKEY=\"ssh-ed25519 AAAA...\"}"
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
case "$DEPLOY_PUBKEY" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;; *) echo "DEPLOY_PUBKEY must be a public key (ssh-ed25519 AAAA...)"; exit 1;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync ufw git xz-utils debian-keyring debian-archive-keyring apt-transport-https

# a little swap: building the website needs more memory than a small VPS has to spare
if [ -z "$(swapon --show --noheadings)" ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node 24, from nodejs.org (its checksum is checked), into /usr/local
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) echo "unsupported CPU $(uname -m)"; exit 1;; esac
  base=https://nodejs.org/dist/latest-v24.x
  file=$(curl -fsSL "$base/SHASUMS256.txt" | grep -o "node-v24\.[0-9.]*-linux-$arch\.tar\.xz" | head -1)
  [ -n "$file" ] || { echo "could not find Node 24 at $base"; exit 1; }
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  want=$(curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | cut -d' ' -f1)
  [ "$(sha256sum "$tmp/$file" | cut -d' ' -f1)" = "$want" ] || { echo "Node's checksum does not match"; exit 1; }
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
  rm -rf "$tmp"
fi
echo "node $(node -v)"

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

# the folders
install -d -m 755 -o deploy -g deploy /opt/grape-build /opt/grape-server /opt/grape-server/payload /var/lib/grape-deploy
install -d -m 2775 -o grape -g deploy /opt/grape-server/.next /opt/grape-server/.next/cache      # Next.js writes its cache there
install -d -m 700 -o grape -g grape /var/lib/grape-server
if [ ! -d /opt/grape-build/.git ]; then
  sudo -u deploy git clone --quiet "$REPO" /opt/grape-build
fi

# the server
install -m 644 "$HERE/grape-server.service" /etc/systemd/system/grape-server.service
sed -i "s#^Environment=GRAPE_PUBLIC_URL=.*#Environment=GRAPE_PUBLIC_URL=https://${DOMAIN}#" /etc/systemd/system/grape-server.service
sed -i 's#^ReadWritePaths=.*#ReadWritePaths=/var/lib/grape-server /opt/grape-server/.next/cache#' /etc/systemd/system/grape-server.service
if [ ! -f /etc/grape-server.env ]; then
  printf '# secrets for the server, one per line:  GRAPE_DISCORD_CLIENT_SECRET=...\n' > /etc/grape-server.env
  chmod 600 /etc/grape-server.env
fi

# the deployer: every minute it looks for a new commit
install -m 644 "$HERE/grape-pull.service" /etc/systemd/system/grape-pull.service
install -m 644 "$HERE/grape-pull.timer" /etc/systemd/system/grape-pull.timer
sed -i 's#^ExecStart=.*#ExecStart=/bin/bash /opt/grape-build/deploy/pull-deploy.sh#' /etc/systemd/system/grape-pull.service

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

# the firewall: SSH, http, https
ufw allow OpenSSH >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable caddy grape-server grape-pull.timer >/dev/null 2>&1
systemctl restart caddy

echo
echo "Setup done. Still to do (the data is the one thing git does not hold):"
echo "  1. put the data in /var/lib/grape-server  (README step 6: backup + restore)"
echo "  2. systemctl start grape-pull.timer       (the first run builds and starts the server)"
