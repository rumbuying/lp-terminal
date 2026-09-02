#!/usr/bin/env bash
# LP Terminal release driver — the docs/PRODUCTION_DEPLOYMENT.zh-CN.md §6/§7
# flow as one command. Drives the production host over SSH from the build tree.
#
#   deploy/release.sh                  # build + ship web AND indexer
#   deploy/release.sh --web            # frontend only
#   deploy/release.sh --indexer        # backend only
#   deploy/release.sh --fast           # skip the full cross-chain test suite
#   deploy/release.sh status           # read-only: what is live, how old, disk
#   deploy/release.sh rollback web|indexer <timestamp>
#
# The executor is deliberately NOT scripted (doc §7.1: check jobs/vault state
# by hand first). Override any default through the env block below.
set -euo pipefail

# ── configuration (env-overridable) ─────────────────────────────────────────
HOST="${RELEASE_HOST:-ubuntu@43.134.42.2}"
DOMAIN="${RELEASE_DOMAIN:-newlp.coinfetcher.xyz}"
DOMAIN_URL="https://$DOMAIN"
WEB_ROOT="${RELEASE_WEB_ROOT:-/var/www/lp-terminal}"
IDX_ROOT="${RELEASE_IDX_ROOT:-/opt/lp-terminal-indexer}"
IDX_USER="${RELEASE_IDX_USER:-lpindexer}"
NODE_BIN="${RELEASE_NODE_BIN:-/opt/node-v22/bin}"
FEE_RECEIVER="${RELEASE_FEE_RECEIVER:-0x2bb53df69efa1b967660f2780ddcf6f76f90ae78}"
# Build env per doc §6: no private RPC baked in, gateway host enables the
# same-origin two-chain routing, kyber as a same-origin proxied path.
BUILD_ENV=(
  "RPC="
  "CHAIN=bsc"
  "VITE_CHAIN_GATEWAY_HOST=$DOMAIN"
  "KYBERSWAP_AGGREGATOR_API_BASE_URL=/kyber"
  "KYBERSWAP_FEE_RECEIVER=$FEE_RECEIVER"
)

# ── ssh plumbing ────────────────────────────────────────────────────────────
KEY="${RELEASE_KEY:-}"
if [[ -z $KEY ]]; then
  for candidate in "$HOME/.ssh/lp_deploy.pem" "LP.pem" "$HOME/.ssh/LP.pem"; do
    if [[ -f $candidate ]]; then KEY=$candidate; break; fi
  done
fi
if [[ -z $KEY || ! -f $KEY ]]; then
  echo "error: no SSH key found (set RELEASE_KEY or place lp_deploy.pem in ~/.ssh)" >&2
  exit 2
fi
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i "$KEY")

r() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

log() { printf '%s\n' "== $*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

on_fail() {
  printf '\n!! release failed at step: %s\n' "$1" >&2
  printf 'rollback (web):     ln -sfn %s/releases/<ts> %s/current.next && sudo mv -Tf %s/current.next %s/current\n' "$WEB_ROOT" "$WEB_ROOT" "$WEB_ROOT" "$WEB_ROOT" >&2
  printf 'rollback (indexer): sudo ln -sfn %s/releases/<ts> %s/app.next && sudo mv -Tf %s/app.next %s/app && sudo systemctl restart lp-terminal-indexer@robinhood lp-terminal-indexer@bsc\n' "$IDX_ROOT" "$IDX_ROOT" "$IDX_ROOT" "$IDX_ROOT" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
LP Terminal release driver (docs/PRODUCTION_DEPLOYMENT.zh-CN.md §6/§7)

  deploy/release.sh                  build + ship web AND indexer
  deploy/release.sh --web            frontend only
  deploy/release.sh --indexer        backend only
  deploy/release.sh --fast           skip the full cross-chain test suite
  deploy/release.sh --allow-dirty    ship with uncommitted changes (discouraged)
  deploy/release.sh status           read-only: what is live, services, disk
  deploy/release.sh rollback web|indexer <YYYYMMDDTHHMMSSZ>

Executor releases stay manual (doc §7.1: jobs + vault state by hand first).
Env overrides: RELEASE_HOST RELEASE_KEY RELEASE_DOMAIN RELEASE_WEB_ROOT
RELEASE_IDX_ROOT RELEASE_IDX_USER RELEASE_NODE_BIN RELEASE_FEE_RECEIVER
USAGE
}

# ── subcommand: status (read-only) ──────────────────────────────────────────
cmd_status() {
  log "live releases"
  r "readlink -f $WEB_ROOT/current; sudo readlink -f $IDX_ROOT/app; sudo readlink -f /opt/lp-terminal-executor/app"
  log "services"
  r "systemctl is-active lp-terminal-indexer@robinhood lp-terminal-indexer@bsc lp-terminal-executor@robinhood lp-terminal-executor@bsc nginx | paste -sd' '"
  log "health"
  curl -fsS -m 8 -o /dev/null -w "  healthz %{http_code}\n" "$DOMAIN_URL/healthz" || true
  r "curl -fsS -m 5 http://127.0.0.1:8787/api/health | grep -o '\"ready\":[a-z]*' | head -1; curl -fsS -m 5 http://127.0.0.1:8788/api/health | grep -o '\"ready\":[a-z]*' | head -1" || true
  log "pool rank snapshot"
  rank_body=$(r "curl -fsS -m 5 http://127.0.0.1:8787/api/pool-rank" 2>/dev/null || true)
  if [[ -n $rank_body ]]; then
    echo "$rank_body" | grep -oE '"ready":(true|false),"generatedAt":[0-9]+' | head -1
    echo "$rank_body" | grep -oE '"rows":\[' >/dev/null && echo "$rank_body" | grep -oE '"pool":"[^"]+"' | head -1 | sed 's/^/  top: /'
  else
    echo "  unavailable"
  fi
  echo
  log "disk"
  r "df -h / | tail -1"
}

# ── subcommand: rollback ────────────────────────────────────────────────────
cmd_rollback() {
  local target=${1:-} ts=${2:-}
  [[ $target == web || $target == indexer ]] || die "rollback target must be 'web' or 'indexer'"
  [[ -n $ts ]] || die "usage: $0 rollback web|indexer <YYYYMMDDTHHMMSSZ>"
  if [[ $target == web ]]; then
    r "test -d $WEB_ROOT/releases/$ts" || die "no such web release: $ts"
    r "sudo ln -sfn $WEB_ROOT/releases/$ts $WEB_ROOT/current.next && sudo mv -Tf $WEB_ROOT/current.next $WEB_ROOT/current"
    log "web rolled back to $ts"
    curl -fsS -m 8 -o /dev/null -w "healthz %{http_code}\n" "$DOMAIN_URL/healthz"
  else
    r "sudo test -d $IDX_ROOT/releases/$ts" || die "no such indexer release: $ts"
    r "sudo ln -sfn $IDX_ROOT/releases/$ts $IDX_ROOT/app.next && sudo mv -Tf $IDX_ROOT/app.next $IDX_ROOT/app && sudo systemctl restart lp-terminal-indexer@robinhood lp-terminal-indexer@bsc"
    log "indexer rolled back to $ts — waiting for ready"
    r "for i in \$(seq 1 48); do a=\$(curl -fsS -m 3 http://127.0.0.1:8787/api/health | grep -c '\"ready\":true' || true); b=\$(curl -fsS -m 3 http://127.0.0.1:8788/api/health | grep -c '\"ready\":true' || true); [ \"\$a\" = 1 ] && [ \"\$b\" = 1 ] && echo BOTH_READY && exit 0; sleep 5; done; echo READY_TIMEOUT; exit 1"
  fi
}

# ── deploy ──────────────────────────────────────────────────────────────────
target=both
fast=false
allow_dirty=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --web) target=web ;;
    --indexer) target=indexer ;;
    --fast) fast=true ;;
    --allow-dirty) allow_dirty=true ;;
    --executor) die "executor releases stay manual — doc §7.1: check jobs and vault state by hand first" ;;
    status) cmd_status; exit 0 ;;
    rollback) shift; cmd_rollback "$@"; exit 0 ;;
    -h|--help)
      usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

ts=$(date -u +%Y%m%dT%H%M%SZ)

log "release $ts → $HOST ($target)"

# 0. traceability: what ships must be committed
if [[ -n $(git status --porcelain) ]]; then
  $allow_dirty || die "working tree is dirty — commit first, or pass --allow-dirty"
  log "WARNING shipping a dirty tree (--allow-dirty)"
fi
log "git $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

# 1. verify + build
log "typecheck"
npm run --silent typecheck
if [[ $fast == false ]]; then
  log "full test suite (both chains) — --fast to skip"
  npm test --silent 2>&1 | tail -3
fi

if [[ $target == web || $target == both ]]; then
  log "build web (production env)"
  env "${BUILD_ENV[@]}" npm run --silent build
  log "secret scan dist/"
  scan_hits=$(grep -rloE 'g\.alchemy\.com/v2/[A-Za-z0-9_-]{20,}|api\.thegraph\.com|BEGIN [A-Z ]*PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY|master\.key|api\.token|LP\.pem' dist/ 2>/dev/null || true)
  [[ -z $scan_hits ]] || { echo "$scan_hits" >&2; die "secret-pattern hit in dist/ — do not ship"; }
  prev_web=$(r "readlink -f $WEB_ROOT/current")

  log "upload web release $ts"
  r "sudo mkdir -p $WEB_ROOT/releases/$ts"
  tar -C dist -cf - . | ssh "${SSH_OPTS[@]}" "$HOST" "sudo tar -x -C $WEB_ROOT/releases/$ts"
  log "switch web current → $ts (was ${prev_web##*/})"
  r "sudo ln -sfn $WEB_ROOT/releases/$ts $WEB_ROOT/current.next && sudo mv -Tf $WEB_ROOT/current.next $WEB_ROOT/current"

  log "verify web"
  curl -fsS -m 10 -o /dev/null "$DOMAIN_URL/healthz" || on_fail "web healthz"
  new_entry=$(curl -fsS -m 10 "$DOMAIN_URL/" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)
  [[ -n $new_entry ]] || on_fail "homepage serves no entry asset"
  log "serving $new_entry"
fi

if [[ $target == indexer || $target == both ]]; then
  log "package indexer release $ts (git archive HEAD)"
  r "sudo mkdir -p $IDX_ROOT/releases/$ts"
  git archive HEAD | ssh "${SSH_OPTS[@]}" "$HOST" "sudo tar -x -C $IDX_ROOT/releases/$ts"
  prev_idx=$(r "sudo readlink -f $IDX_ROOT/app")

  log "install dependencies (as $IDX_USER, production node)"
  r "sudo chown -R $IDX_USER:$IDX_USER $IDX_ROOT/releases/$ts"
  r "IDX=$IDX_ROOT/releases/$ts NODE_BIN=$NODE_BIN IDX_USER=$IDX_USER bash -s" <<'REMOTE' | tail -2
set -euo pipefail
cd "$IDX"
sudo -u "$IDX_USER" env HOME=/opt/lp-terminal-indexer PATH="$NODE_BIN:/usr/bin:/bin" "$NODE_BIN/npm" ci --no-audit --no-fund
REMOTE

  log "module smoke (throws away its temp db)"
  r "REL=$IDX_ROOT/releases/$ts NODE_BIN=$NODE_BIN IDX_USER=$IDX_USER bash -s" <<'REMOTE'
set -euo pipefail
printf 'await import("%s/indexer/api.ts")\nconsole.log("IMPORT_OK")\n' "$REL" > /tmp/rel-smoke.mjs
cd "$REL"
sudo -u "$IDX_USER" env HOME=/opt/lp-terminal-indexer PATH="$NODE_BIN:/usr/bin:/bin" INDEXER_DB=/tmp/rel-smoke.db CHAIN=robinhood "$NODE_BIN/node" --import=tsx /tmp/rel-smoke.mjs
rm -f /tmp/rel-smoke.mjs /tmp/rel-smoke.db*
REMOTE

  log "switch indexer app → $ts (was ${prev_idx##*/})"
  r "sudo ln -sfn $IDX_ROOT/releases/$ts $IDX_ROOT/app.next && sudo mv -Tf $IDX_ROOT/app.next $IDX_ROOT/app"
  log "restart both indexers, wait for ready"
  r "sudo systemctl restart lp-terminal-indexer@robinhood lp-terminal-indexer@bsc"
  r "for i in \$(seq 1 48); do a=\$(curl -fsS -m 3 http://127.0.0.1:8787/api/health | grep -c '\"ready\":true' || true); b=\$(curl -fsS -m 3 http://127.0.0.1:8788/api/health | grep -c '\"ready\":true' || true); [ \"\$a\" = 1 ] && [ \"\$b\" = 1 ] && echo BOTH_READY && exit 0; sleep 5; done; echo READY_TIMEOUT; exit 1" \
    || on_fail "indexer ready timeout"
  log "pool-rank probe (first snapshot lands ~2min after restart)"
  r "curl -fsS -m 5 http://127.0.0.1:8787/api/pool-rank | head -c 160" || true
  echo
fi

# 2. public go-live checks (doc §8) — executor endpoints are informational:
#    this script never touches the executor.
log "public checks"
curl -fsS -m 10 -o /dev/null "$DOMAIN_URL/_chain/robinhood/api/health" || on_fail "robinhood api health"
curl -fsS -m 10 -o /dev/null "$DOMAIN_URL/_chain/bsc/api/health" || on_fail "bsc api health"
for chain in robinhood bsc; do
  curl -fsS -m 10 "$DOMAIN_URL/_chain/$chain/executor/health" | grep -o '"ok":true' >/dev/null \
    || log "WARNING: $chain executor health not ok (script does not manage executors)"
done

# 3. retention (script self-protects the live symlinks; dry the eyes first)
log "prune releases (keep 3)"
r "sudo $IDX_ROOT/app/deploy/prune-releases.sh | tail -4"
r "sudo $IDX_ROOT/app/deploy/prune-releases.sh --apply | tail -1"

log "DONE — live:"
r "readlink -f $WEB_ROOT/current; sudo readlink -f $IDX_ROOT/app; df -h / | tail -1"
