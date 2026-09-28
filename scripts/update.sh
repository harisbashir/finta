#!/usr/bin/env bash
# Finta updater — backs up your data, gets the latest code, rebuilds and restarts.
#
#   bash scripts/update.sh              update to the latest on the current branch
#   bash scripts/update.sh v1.1.1       switch to a specific release tag
#   bash scripts/update.sh --no-backup  skip the backup (not recommended)
#
# Your data lives in a Docker volume and is never touched by an update. A copy of the
# database is saved to ./backups/ first, so you can always go back.
set -euo pipefail

REF=""; BACKUP=1
for a in "$@"; do
  case "$a" in
    --no-backup) BACKUP=0 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'Unknown option: %s\n' "$a" >&2; exit 1 ;;
    *) REF="$a" ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f server/index.js ] || fail "Run this from the Finta folder (scripts/update.sh)."
[ -f .env ] || fail "No .env here yet. Run scripts/install.sh first."

DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER info >/dev/null 2>&1 || fail "Docker isn't running. Try: sudo systemctl start docker"

version() { grep -m1 '"version"' package.json | sed -E 's/.*"([0-9][^"]*)".*/\1/'; }
OLD="$(version)"
bold "Updating Finta (now $OLD)"

# ── 1. Back up ───────────────────────────────────────────────────────────────
if [ "$BACKUP" -eq 1 ]; then
  if $DOCKER compose ps --status running --services 2>/dev/null | grep -qx finta; then
    step "Backing up your data"
    out="$($DOCKER compose exec -T finta node --disable-warning=ExperimentalWarning server/cli.js backup)"
    file="$(printf '%s' "$out" | sed -n 's/^Backup written to //p')"
    mkdir -p backups && chmod 700 backups
    if [ -n "$file" ] && $DOCKER compose cp "finta:$file" "backups/$(basename "$file")" >/dev/null 2>&1; then
      info "Saved backups/$(basename "$file")"
    else
      info "$out (kept inside the data volume)"
    fi
  else
    info "Finta isn't running, so there's nothing to back up right now."
  fi
fi

# ── 2. Get the new code ──────────────────────────────────────────────────────
step "Getting the latest code"
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  fail "You have local changes to Finta's files (above). Commit or undo them (git stash), then run this again."
fi
git fetch --tags --prune origin

# Files the old install guide asked you to create by hand now ship with Finta.
# Move a hand-made copy aside so git can bring in the official one.
f=compose.vm.yaml
{
  if [ -f "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    mv "$f" "$f.old"; info "Moved your own $f to $f.old (Finta now includes it)."
  fi
}

if [ -n "$REF" ]; then
  git -c advice.detachedHead=false checkout "$REF"
else
  branch="$(git symbolic-ref --short -q HEAD || true)"
  [ -n "$branch" ] || fail "You're on a fixed release. Name one to switch to, e.g. bash scripts/update.sh v1.1.1 — or: git checkout main"
  git pull --ff-only origin "$branch"
fi
NEW="$(version)"

# ── 3. Rebuild and restart ───────────────────────────────────────────────────
step "Rebuilding and restarting"
$DOCKER compose up -d --build --remove-orphans

step "Checking it's healthy"
ok=0
for _ in $(seq 1 60); do
  if $DOCKER compose exec -T finta node -e "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" -eq 1 ] || { $DOCKER compose logs --tail 40 finta; fail "Finta didn't come back up. The log above says why. Your backup is in ./backups."; }

$DOCKER image prune -f >/dev/null 2>&1 || true

printf '\n'
if [ "$OLD" = "$NEW" ]; then bold "✓ Finta $NEW is up to date and running"
else bold "✓ Updated Finta $OLD → $NEW"; info "What's new: CHANGELOG.md"; fi
URL="$(grep -E '^APP_URL=' .env | tail -n1 | cut -d= -f2-)"
[ -n "$URL" ] && info "Open: $URL"
