#!/usr/bin/env bash
# Finta installer — sets up Docker (if needed), the app and its settings, then starts it.
#
#   Local network (default):   bash scripts/install.sh
#   Public with HTTPS:         bash scripts/install.sh --domain home.example.com
#
# Or, on a fresh machine without the code yet:
#   curl -fsSL https://raw.githubusercontent.com/harisbashir/finta/main/scripts/install.sh | bash
#
# Options
#   --domain NAME   Public HTTPS setup with Caddy + Let's Encrypt (ports 80/443 must reach this machine).
#   --ip ADDRESS    Address people will type on your network (default: detected).
#   --port N        Port for the local-network setup (default: 3000).
#   --tz ZONE       Time zone, e.g. America/Toronto (default: this machine's).
#   --dir PATH      Where to put the code when it isn't already here (default: ~/finta).
#   --repo URL      Git repository to clone (default: https://github.com/harisbashir/finta.git).
#   -y, --yes       Don't ask questions; accept the defaults.
#
# Safe to run again: it keeps your existing .env and data, and just rebuilds and restarts.
set -euo pipefail

REPO_URL="https://github.com/harisbashir/finta.git"
DIR="${HOME}/finta"
DOMAIN=""; IP=""; PORT=""; TZ_OPT=""; ASSUME_YES=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain needs a name}"; shift 2 ;;
    --ip) IP="${2:?--ip needs an address}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --tz) TZ_OPT="${2:?--tz needs a zone}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --repo) REPO_URL="${2:?--repo needs a URL}"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option: $1 (try --help)" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || fail "This installer is for Linux. On Mac or Windows, install Docker Desktop and run: docker compose -f compose.local.yaml up -d --build"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "Run as root, or install sudo."
  SUDO="sudo"
fi

bold "Finta installer"

# ── 1. Git and curl ───────────────────────────────────────────────────────────
need_pkgs=()
command -v git >/dev/null 2>&1 || need_pkgs+=(git)
command -v curl >/dev/null 2>&1 || need_pkgs+=(curl)
if [ ${#need_pkgs[@]} -gt 0 ]; then
  step "Installing ${need_pkgs[*]}"
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "${need_pkgs[@]}" ca-certificates
  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y -q "${need_pkgs[@]}"
  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y -q "${need_pkgs[@]}"
  else fail "Please install ${need_pkgs[*]} and run this again."; fi
fi

# ── 2. Docker Engine + Compose ───────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  step "Installing Docker (official script from get.docker.com)"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  $SUDO sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
  if [ -n "$SUDO" ]; then $SUDO usermod -aG docker "$USER" || true; fi
else
  info "Docker is already installed: $(docker --version)"
fi
docker compose version >/dev/null 2>&1 || $SUDO docker compose version >/dev/null 2>&1 \
  || fail "Docker Compose v2 is missing. Install the docker-compose-plugin package and run this again."

# Use sudo for docker until the user logs in again with the docker group.
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="$SUDO docker"
$DOCKER info >/dev/null 2>&1 || fail "Docker isn't running. Try: sudo systemctl start docker"

# ── 3. The code ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../server/index.js" ]; then
  DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  info "Using the code in $DIR"
elif [ -f "$DIR/server/index.js" ]; then
  info "Using the code in $DIR"
else
  step "Downloading Finta into $DIR"
  git clone --depth 50 "$REPO_URL" "$DIR"
fi
cd "$DIR"

# ── 4. Settings (.env) ───────────────────────────────────────────────────────
env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true; }
env_set() { # key value — replace or append, keeping everything else
  if [ -f .env ] && grep -qE "^$1=" .env; then
    local tmp; tmp="$(mktemp)"; awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
  else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
ask() { # prompt default → answer
  local a=""
  if [ "$ASSUME_YES" -eq 0 ] && [ -r /dev/tty ]; then read -r -p "  $1 [$2]: " a < /dev/tty || true; fi
  printf '%s' "${a:-$2}"
}

step "Settings"
touch .env && chmod 600 .env
[ -z "$TZ_OPT" ] && TZ_OPT="$(env_get TZ)"
[ -z "$TZ_OPT" ] && TZ_OPT="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
[ -z "$(env_get TZ)" ] && TZ_OPT="$(ask 'Time zone' "$TZ_OPT")"
env_set TZ "$TZ_OPT"

if [ -z "$DOMAIN" ] && [ "$(env_get COMPOSE_FILE)" = "compose.yaml" ]; then DOMAIN="$(env_get DOMAIN)"; fi

if [ -n "$DOMAIN" ]; then
  MODE="public"
  env_set DOMAIN "$DOMAIN"
  env_set APP_URL "https://$DOMAIN"
  env_set COMPOSE_FILE "compose.yaml"
  URL="https://$DOMAIN"
  info "Public setup: $URL (make sure DNS points here and ports 80 and 443 are open)"
else
  MODE="lan"
  [ -z "$PORT" ] && PORT="$(env_get FINTA_PORT)"; PORT="${PORT:-3000}"
  if [ -z "$IP" ]; then
    current="$(env_get APP_URL)"
    case "$current" in http://*) IP="$(printf '%s' "$current" | sed -E 's#http://([^:/]+).*#\1#')";; esac
  fi
  if [ -z "$IP" ]; then
    detected="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [ -z "$detected" ] && detected="$(hostname -I 2>/dev/null | awk '{print $1}')"
    IP="$(ask 'Address people will type (this machine on your network)' "${detected:-localhost}")"
  fi
  env_set FINTA_PORT "$PORT"
  env_set APP_URL "http://$IP:$PORT"
  env_set COMPOSE_FILE "compose.vm.yaml"
  URL="http://$IP:$PORT"
  info "Local-network setup: $URL"
fi

# ── 5. Firewall (only if ufw is active) ──────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  step "Opening the firewall"
  if [ "$MODE" = "public" ]; then $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow 443 >/dev/null
  else $SUDO ufw allow "$PORT/tcp" >/dev/null; fi
fi

# ── 6. Build and start ───────────────────────────────────────────────────────
step "Building and starting (the first build takes a minute)"
$DOCKER compose up -d --build

step "Waiting for Finta to be ready"
ok=0
for _ in $(seq 1 60); do
  if $DOCKER compose exec -T finta node -e "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" -eq 1 ] || { $DOCKER compose logs --tail 40 finta; fail "Finta didn't start. The log above says why."; }

VERSION="$(grep -m1 '"version"' package.json | sed -E 's/.*"([0-9][^"]*)".*/\1/')"
CODE="$($DOCKER compose logs finta 2>/dev/null | grep -o 'Setup code: [A-Z0-9]*' | tail -n1 | awk '{print $3}')"

printf '\n'
bold "✓ Finta $VERSION is running"
info "Open:        $URL"
if [ -n "$CODE" ]; then
  info "Setup code:  $CODE   (needed once, to create the first account)"
fi
info "Update:      bash scripts/update.sh"
info "Back up:     $DOCKER compose exec finta node server/cli.js backup"
info "Logs:        $DOCKER compose logs -f finta"
if [ "$DOCKER" != "docker" ]; then
  info "Tip: log out and back in so you can run docker without sudo."
fi
