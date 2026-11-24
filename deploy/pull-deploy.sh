#!/usr/bin/env bash
# Auto-deploy, run every minute by grape-pull.timer as the "deploy" user. It does nothing unless main has a new commit.
#
# A new commit is built in /opt/grape-build (a clone), NEVER in the folder the server runs from: it is tested, built, and only if
# both pass is it copied to /opt/grape-server and the server restarted. A commit that fails is remembered and not tried again
# until there is a newer one; the server keeps running the last good version meanwhile.
#
#   journalctl -u grape-pull -n 40        what the last runs did
set -euo pipefail

# Everything is in one function that is read completely before it runs: this very file is replaced by the new commit
# (git reset) while it is running, and bash reads a script as it goes.
main() {
  local BUILD=/opt/grape-build LIVE=/opt/grape-server STATE=/var/lib/grape-deploy BRANCH=main
  mkdir -p "$STATE"
  exec 9>"$STATE/lock"
  flock -n 9 || return 0                                    # a deploy is already running

  cd "$BUILD"
  local remote
  remote=$(git ls-remote --heads origin "$BRANCH" | cut -f1)
  [ -n "$remote" ] || { echo "could not ask GitHub (offline?)"; return 0; }
  [ "$remote" != "$(cat "$STATE/deployed" 2>/dev/null || true)" ] || return 0
  [ "$remote" != "$(cat "$STATE/failed" 2>/dev/null || true)" ] || return 0

  fail() { echo "$remote" > "$STATE/failed"; echo "DEPLOY FAILED at: $1. The server still runs the last good version." >&2; exit 1; }
  echo "deploying ${remote:0:10} (was $(cut -c1-10 "$STATE/deployed" 2>/dev/null || echo nothing))"

  git fetch --quiet origin "$BRANCH" || fail "git fetch"
  git reset --hard --quiet FETCH_HEAD || fail "git reset"
  npm ci --no-audit --no-fund --loglevel=error || fail "npm ci"
  npm test --silent || fail "the tests"
  npm run build --silent || fail "the website build"

  # the result goes live: code, built website and dependencies. data/ and payload/ belong to the server: never touched.
  rsync -rlt --omit-dir-times --no-perms --delete --exclude '/.git' --exclude '/data' --exclude '/payload' --exclude '/.next/cache' ./ "$LIVE/" || fail "copying to $LIVE"
  sudo -n /usr/bin/systemctl restart grape-server || fail "restarting the server"

  local i
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8787/v1/health 2>/dev/null | grep -q '"ok":true'; then
      echo "$remote" > "$STATE/deployed"
      rm -f "$STATE/failed"
      echo "deployed ${remote:0:10}: the server answers"
      return 0
    fi
    sleep 2
  done
  echo "$remote" > "$STATE/deployed"        # it is the live code now, whatever it does: do not rebuild it every minute
  echo "WARNING: the server was restarted but did not answer in time: journalctl -u grape-server -n 50" >&2
  return 1
}

main "$@"
exit $?
