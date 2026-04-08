#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage:
  scripts/ln-bootstrap.sh --node <name> [options]

Options:
  --node <name>                 Local node name (required).
  --network <name>              LND network (default: regtest).
  --ln-impl <name>              LN impl (must be lnd; default: lnd).
  --ln-backend <name>           LN backend (must be cli; default: cli).
  --ln-compose-file <path>      Accepted for config compatibility; rejected if provided.
  --ln-service <name>           Accepted for config compatibility; rejected if provided.
  --lnd-dir <path>              Override local LND dir (default: onchain/lnd/<network>/<node>).
  --lnd-bin <path>              Override lnd binary for start.
  --lncli-bin <path>            Override lncli binary for wallet lifecycle.
  --lnd-rpcserver <host:port>   Optional explicit lncli rpcserver.
  --lnd-tlscert <path>          Optional explicit lncli TLS cert path.
  --lnd-macaroon <path>         Optional explicit lncli admin macaroon path.
  --wallet-password-file <path> Password file for create/unlock.
  --peer-node <name>            Peer node name for local two-node setup.
  --peer-lnd-dir <path>         Override peer LND dir.
  --peer-host <host>            Peer host when deriving URI from --peer-node (default: 127.0.0.1).
  --peer-uri <nodeid@host:port> Explicit peer URI (overrides --peer-node resolution).
  --channel-amount-sats <n>     Channel size to open when peer is set (default: 1000000).
  --wait-funding 0|1            Poll until confirmed on-chain funds exist (default: 0).
  --funding-timeout-sec <n>     Funding wait timeout (default: 600).
  --funding-poll-sec <n>        Funding poll interval (default: 5).

Notes:
  - This script is infrastructure-only. It does not read or write swap state.
  - It reuses scripts/lndctl.mjs and scripts/lnctl.mjs.
  - Wallet creation is only attempted when a password file is available.
EOF
}

die() {
  echo "$*" >&2
  exit 1
}

bool_flag() {
  case "${1:-}" in
    1|true|TRUE|yes|YES) echo 1 ;;
    0|false|FALSE|no|NO|'') echo 0 ;;
    *) die "Invalid boolean value: $1 (expected 0|1)" ;;
  esac
}

json_field() {
  local path="$1"
  local default_value="${2:-}"
  node -e '
    const path = process.argv[1].split(".").filter(Boolean);
    const fallback = process.argv[2];
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const j = JSON.parse(s || "{}");
      let v = j;
      for (const p of path) {
        if (v === null || v === undefined) {
          v = undefined;
          break;
        }
        v = v[p];
      }
      if (v === null || v === undefined || v === "") {
        if (fallback !== undefined && fallback !== "") {
          process.stdout.write(String(fallback));
          return;
        }
        process.exit(3);
      }
      process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
    });
  ' "$path" "$default_value"
}

normalize_network() {
  local raw="${1:-regtest}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    mainnet|main|bitcoin|btc) echo "mainnet" ;;
    testnet|test) echo "testnet" ;;
    signet) echo "signet" ;;
    regtest|reg) echo "regtest" ;;
    *) die "Unsupported --network: $1" ;;
  esac
}

default_lnd_dir() {
  local network="$1"
  local node="$2"
  printf '%s/onchain/lnd/%s/%s\n' "$ROOT" "$network" "$node"
}

discover_password_file() {
  local network="$1"
  local node="$2"
  local lnd_dir="$3"
  local base="$ROOT/onchain/lnd/$network"
  local candidates=(
    "$lnd_dir/wallet.pw"
    "$base/$node.wallet-password.txt"
    "$base/wallet.pw"
  )
  local role=""
  if [[ "$node" =~ maker ]]; then
    role="maker"
  elif [[ "$node" =~ taker ]]; then
    role="taker"
  fi
  if [[ -n "$role" ]]; then
    candidates+=("$base/$role.wallet-password.txt")
  fi
  local p=""
  for p in "${candidates[@]}"; do
    if [[ -f "$p" ]]; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

NODE=""
NETWORK="regtest"
LN_IMPL="${LN_IMPL:-lnd}"
LN_BACKEND="${LN_BACKEND:-cli}"
LN_COMPOSE_FILE="${LN_COMPOSE_FILE:-}"
LN_SERVICE="${LN_SERVICE:-}"
LND_DIR="${LND_DIR:-}"
LND_BIN="${LND_BIN:-}"
LNCLI_BIN="${LNCLI_BIN:-}"
LND_RPCSERVER="${LND_RPCSERVER:-}"
LND_TLSCERT="${LND_TLSCERT:-}"
LND_MACAROON="${LND_MACAROON:-}"
WALLET_PASSWORD_FILE="${WALLET_PASSWORD_FILE:-}"
PEER_NODE=""
PEER_LND_DIR="${PEER_LND_DIR:-}"
PEER_HOST="${PEER_HOST:-127.0.0.1}"
PEER_URI="${PEER_URI:-}"
CHANNEL_AMOUNT_SATS="${CHANNEL_AMOUNT_SATS:-1000000}"
WAIT_FUNDING="$(bool_flag "${WAIT_FUNDING:-0}")"
FUNDING_TIMEOUT_SEC="${FUNDING_TIMEOUT_SEC:-600}"
FUNDING_POLL_SEC="${FUNDING_POLL_SEC:-5}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) NODE="${2:-}"; shift 2 ;;
    --network) NETWORK="${2:-}"; shift 2 ;;
    --ln-impl) LN_IMPL="${2:-}"; shift 2 ;;
    --ln-backend) LN_BACKEND="${2:-}"; shift 2 ;;
    --ln-compose-file) LN_COMPOSE_FILE="${2:-}"; shift 2 ;;
    --ln-service) LN_SERVICE="${2:-}"; shift 2 ;;
    --lnd-dir) LND_DIR="${2:-}"; shift 2 ;;
    --lnd-bin) LND_BIN="${2:-}"; shift 2 ;;
    --lncli-bin) LNCLI_BIN="${2:-}"; shift 2 ;;
    --lnd-rpcserver) LND_RPCSERVER="${2:-}"; shift 2 ;;
    --lnd-tlscert) LND_TLSCERT="${2:-}"; shift 2 ;;
    --lnd-macaroon) LND_MACAROON="${2:-}"; shift 2 ;;
    --wallet-password-file) WALLET_PASSWORD_FILE="${2:-}"; shift 2 ;;
    --peer-node) PEER_NODE="${2:-}"; shift 2 ;;
    --peer-lnd-dir) PEER_LND_DIR="${2:-}"; shift 2 ;;
    --peer-host) PEER_HOST="${2:-}"; shift 2 ;;
    --peer-uri) PEER_URI="${2:-}"; shift 2 ;;
    --channel-amount-sats) CHANNEL_AMOUNT_SATS="${2:-}"; shift 2 ;;
    --wait-funding) WAIT_FUNDING="$(bool_flag "${2:-}")"; shift 2 ;;
    --funding-timeout-sec) FUNDING_TIMEOUT_SEC="${2:-}"; shift 2 ;;
    --funding-poll-sec) FUNDING_POLL_SEC="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -n "$NODE" ]] || die "Missing --node"
NETWORK="$(normalize_network "$NETWORK")"
[[ "${LN_IMPL,,}" == "lnd" ]] || die "scripts/ln-bootstrap.sh only supports --ln-impl lnd"
[[ "${LN_BACKEND,,}" == "cli" ]] || die "scripts/ln-bootstrap.sh only supports --ln-backend cli"
[[ -z "$LN_COMPOSE_FILE" ]] || die "scripts/ln-bootstrap.sh does not support --ln-compose-file; use local LND dirs"
[[ -z "$LN_SERVICE" ]] || die "scripts/ln-bootstrap.sh does not support --ln-service; use local LND dirs"
[[ "$CHANNEL_AMOUNT_SATS" =~ ^[0-9]+$ ]] || die "Invalid --channel-amount-sats"
[[ "$FUNDING_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || die "Invalid --funding-timeout-sec"
[[ "$FUNDING_POLL_SEC" =~ ^[0-9]+$ ]] || die "Invalid --funding-poll-sec"

if [[ -z "$LND_DIR" ]]; then
  LND_DIR="$(default_lnd_dir "$NETWORK" "$NODE")"
fi
if [[ -z "$PEER_URI" && -n "$PEER_NODE" && -z "$PEER_LND_DIR" ]]; then
  PEER_LND_DIR="$(default_lnd_dir "$NETWORK" "$PEER_NODE")"
fi
if [[ -z "$WALLET_PASSWORD_FILE" ]]; then
  WALLET_PASSWORD_FILE="$(discover_password_file "$NETWORK" "$NODE" "$LND_DIR" || true)"
fi

LNDCTL=(node scripts/lndctl.mjs)
LNCTL=(node scripts/lnctl.mjs --impl lnd --backend cli --network "$NETWORK" --lnd-dir "$LND_DIR")

if [[ -n "$LND_BIN" ]]; then
  LNDCTL+=(--lnd-bin "$LND_BIN")
fi
if [[ -n "$LNCLI_BIN" ]]; then
  LNDCTL+=(--lncli-bin "$LNCLI_BIN")
  LNCTL+=(--cli-bin "$LNCLI_BIN")
fi
if [[ -n "$LND_RPCSERVER" ]]; then
  LNCTL+=(--lnd-rpcserver "$LND_RPCSERVER")
fi
if [[ -n "$LND_TLSCERT" ]]; then
  LNCTL+=(--lnd-tlscert "$LND_TLSCERT")
fi
if [[ -n "$LND_MACAROON" ]]; then
  LNCTL+=(--lnd-macaroon "$LND_MACAROON")
fi

run_lndctl() {
  "${LNDCTL[@]}" "$@"
}

run_lnctl() {
  "${LNCTL[@]}" "$@"
}

info_json() {
  run_lnctl info 2>/dev/null
}

balance_json() {
  run_lnctl balance 2>/dev/null
}

listfunds_json() {
  run_lnctl listfunds 2>/dev/null
}

wallet_artifact_exists() {
  [[ -f "$LND_DIR/data/chain/bitcoin/$NETWORK/admin.macaroon" || -f "$LND_DIR/data/chain/bitcoin/$NETWORK/wallet.db" ]]
}

ensure_config() {
  if [[ -f "$LND_DIR/lnd.conf" ]]; then
    return 0
  fi
  mkdir -p "$LND_DIR"
  local args=(init --node "$NODE" --network "$NETWORK" --lnd-dir "$LND_DIR")
  if [[ -n "$WALLET_PASSWORD_FILE" ]]; then
    args+=(--wallet-password-file "$WALLET_PASSWORD_FILE")
  fi
  run_lndctl "${args[@]}" >/dev/null
}

is_running() {
  if info_json >/dev/null; then
    return 0
  fi
  if pgrep -f -- "--lnddir=$LND_DIR" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

wait_for_info() {
  local tries="${1:-60}"
  local sleep_sec="${2:-1}"
  local i=0
  while (( i < tries )); do
    if info_json >/dev/null; then
      return 0
    fi
    sleep "$sleep_sec"
    i=$((i + 1))
  done
  return 1
}

ensure_running() {
  if is_running; then
    return 0
  fi
  mkdir -p "$LND_DIR"
  local log_file="$LND_DIR/lnd.start.log"
  nohup "${LNDCTL[@]}" start --node "$NODE" --network "$NETWORK" --lnd-dir "$LND_DIR" >"$log_file" 2>&1 &
  disown || true
  wait_for_info 90 1 || true
}

ensure_wallet_ready() {
  if info_json >/dev/null; then
    return 0
  fi

  [[ -n "$WALLET_PASSWORD_FILE" ]] || die "Wallet not ready and no password file found. Pass --wallet-password-file."
  [[ -f "$WALLET_PASSWORD_FILE" ]] || die "Wallet password file not found: $WALLET_PASSWORD_FILE"

  local pw=""
  pw="$(tr -d '\r\n' <"$WALLET_PASSWORD_FILE")"
  [[ -n "$pw" ]] || die "Wallet password file is empty: $WALLET_PASSWORD_FILE"

  if wallet_artifact_exists; then
    if ! printf '%s\n' "$pw" | "${LNDCTL[@]}" unlock --node "$NODE" --network "$NETWORK" --lnd-dir "$LND_DIR" >/dev/null 2>&1; then
      true
    fi
  else
    local lncli_bin="${LNCLI_BIN:-lncli}"
    local tls_cert_path="$LND_DIR/tls.cert"
    printf '[lncli] command=create rpcserver=%s lnddir=%s tlscertpath=%s\n' "${LND_RPCSERVER:-}" "$LND_DIR" "$tls_cert_path" >&2
    printf '%s\n%s\nn\n\n' "$pw" "$pw" | "$lncli_bin" --network="$NETWORK" --lnddir="$LND_DIR" --tlscertpath="$tls_cert_path" create >/dev/null
  fi

  wait_for_info 60 1 || die "LND did not become ready after wallet create/unlock"
}

extract_node_id() {
  local info="$1"
  printf '%s' "$info" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const j = JSON.parse(s || "{}");
      const out = String(j?.info?.identity_pubkey || j?.info?.id || "").trim();
      if (!out) process.exit(3);
      process.stdout.write(out);
    });
  '
}

extract_address() {
  local out="$1"
  printf '%s' "$out" | json_field "address"
}

extract_confirmed_sat() {
  local out="$1"
  printf '%s' "$out" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const j = JSON.parse(s || "{}");
      const msat = BigInt(String(j?.onchain_confirmed_msat || "0"));
      process.stdout.write(String(msat / 1000n));
    });
  '
}

peer_port_from_conf() {
  local conf_path="$1"
  if [[ ! -f "$conf_path" ]]; then
    echo "9735"
    return 0
  fi
  local listen=""
  listen="$(grep -E '^[[:space:]]*listen=' "$conf_path" | tail -n 1 | cut -d'=' -f2- | tr -d '[:space:]' || true)"
  if [[ "$listen" =~ :([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "9735"
  fi
}

has_active_channel() {
  local peer_node_id="$1"
  local funds
  funds="$(listfunds_json || true)"
  [[ -n "$funds" ]] || return 1
  printf '%s' "$funds" | node -e '
    const peer = String(process.argv[1] || "").trim().toLowerCase();
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const j = JSON.parse(s || "{}");
      const arr = Array.isArray(j?.result?.channels?.channels) ? j.result.channels.channels : [];
      const match = arr.find((c) => String(c?.remote_pubkey || "").trim().toLowerCase() === peer && Boolean(c?.active));
      process.exit(match ? 0 : 1);
    });
  ' "$peer_node_id"
}

ensure_config
ensure_running
ensure_wallet_ready

INFO_JSON="$(info_json)" || die "Failed to query LN info after startup"
NODE_ID="$(extract_node_id "$INFO_JSON")"
ADDR_JSON="$(run_lnctl newaddr)"
FUNDING_ADDRESS="$(extract_address "$ADDR_JSON")"

echo "node=$NODE"
echo "network=$NETWORK"
echo "lnd_dir=$LND_DIR"
echo "node_pubkey=$NODE_ID"
echo "funding_address=$FUNDING_ADDRESS"

if [[ "$WAIT_FUNDING" == "1" ]]; then
  deadline=$(( $(date +%s) + FUNDING_TIMEOUT_SEC ))
  while true; do
    BAL_JSON="$(balance_json || true)"
    if [[ -n "$BAL_JSON" ]]; then
      CONFIRMED_SAT="$(extract_confirmed_sat "$BAL_JSON")"
      if [[ "$CONFIRMED_SAT" =~ ^[0-9]+$ ]] && (( CONFIRMED_SAT > 0 )); then
        echo "confirmed_balance_sats=$CONFIRMED_SAT"
        break
      fi
    fi
    if (( $(date +%s) >= deadline )); then
      die "Timed out waiting for confirmed LN wallet funding"
    fi
    sleep "$FUNDING_POLL_SEC"
  done
fi

if [[ -z "$PEER_URI" && -n "$PEER_NODE" ]]; then
  [[ -n "$PEER_LND_DIR" ]] || die "Missing peer LND dir resolution"
  PEER_LNCTL=(node scripts/lnctl.mjs --impl lnd --backend cli --network "$NETWORK" --lnd-dir "$PEER_LND_DIR")
  if [[ -n "$LNCLI_BIN" ]]; then
    PEER_LNCTL+=(--cli-bin "$LNCLI_BIN")
  fi
  PEER_INFO="$("${PEER_LNCTL[@]}" info)"
  PEER_NODE_ID="$(extract_node_id "$PEER_INFO")"
  PEER_PORT="$(peer_port_from_conf "$PEER_LND_DIR/lnd.conf")"
  PEER_URI="${PEER_NODE_ID}@${PEER_HOST}:${PEER_PORT}"
fi

if [[ -n "$PEER_URI" ]]; then
  PEER_NODE_ID="${PEER_URI%@*}"
  if has_active_channel "$PEER_NODE_ID"; then
    echo "channel_status=already_active"
  else
    run_lnctl connect --peer "$PEER_URI" >/dev/null || true
    if ! has_active_channel "$PEER_NODE_ID"; then
      run_lnctl fundchannel --node-id "$PEER_NODE_ID" --amount-sats "$CHANNEL_AMOUNT_SATS" >/dev/null || true
    fi
    deadline=$(( $(date +%s) + FUNDING_TIMEOUT_SEC ))
    while ! has_active_channel "$PEER_NODE_ID"; do
      if (( $(date +%s) >= deadline )); then
        die "Timed out waiting for active channel to $PEER_NODE_ID"
      fi
      sleep "$FUNDING_POLL_SEC"
    done
    echo "channel_status=active"
    echo "peer_uri=$PEER_URI"
    echo "channel_amount_sats=$CHANNEL_AMOUNT_SATS"
  fi
fi
