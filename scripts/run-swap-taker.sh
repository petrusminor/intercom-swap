#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

. scripts/_env.sh

# Dev-oriented swap taker/client peer.
# - joins the public RFQ channel (to see RFQs/quotes)
# - requires invites for swap:* channels
#
# Notes:
# - Welcome enforcement is disabled here to keep RFQ join friction low. For stricter authenticity,
#   remove `--sidechannel-welcome-required 0` and distribute owner+welcome for the RFQ channel.
#
# Usage:
#   SWAP_INVITER_KEYS="<makerPeerPubkeyHex[,more]>" scripts/run-swap-taker.sh [storeName] [scBridgePort] [rfqChannel]

STORE_NAME="${1:-swap-taker}"
SC_PORT="${2:-49223}"
RFQ_CHANNEL="${3:-0000intercomswapbtcusdt}"
shift 3 || true

SIDECHANNEL_POW="${SIDECHANNEL_POW:-1}"
SIDECHANNEL_POW_DIFFICULTY="${SIDECHANNEL_POW_DIFFICULTY:-12}"

INVITER_KEYS="${SWAP_INVITER_KEYS:-}"
if [[ -n "$INVITER_KEYS" ]]; then
  echo "[taker] using explicit inviter keys" >&2
else
  echo "[taker] running in dynamic invite mode (no preconfigured inviter keys)" >&2
fi

TOKEN_DIR="onchain/sc-bridge"
TOKEN_FILE="${TOKEN_DIR}/${STORE_NAME}.token"
mkdir -p "$TOKEN_DIR"
if [[ ! -f "$TOKEN_FILE" ]]; then
  token="$(
    openssl rand -hex 32 2>/dev/null || \
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  )"
  printf '%s\n' "$token" >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
fi
SC_TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"

ARGS=(
  --peer-store-name "$STORE_NAME"
  --msb 0
  --price-oracle 1
  --sc-bridge 1
  --sc-bridge-token "$SC_TOKEN"
  --sc-bridge-port "$SC_PORT"
  --sidechannels "$RFQ_CHANNEL"
  --sidechannel-pow "$SIDECHANNEL_POW"
  --sidechannel-pow-difficulty "$SIDECHANNEL_POW_DIFFICULTY"
  --sidechannel-welcome-required 0
  --sidechannel-invite-required 1
  --sidechannel-invite-prefixes "swap:"
)

if [[ -n "$INVITER_KEYS" ]]; then
  ARGS+=(--sidechannel-inviter-keys "$INVITER_KEYS")
fi

exec pear run . "${ARGS[@]}" "$@"
