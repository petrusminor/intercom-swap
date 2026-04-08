#!/usr/bin/env bash
set -euo pipefail

NETWORK="mainnet"
LNCLI_BIN="lncli"
LND_DIR=""
TLS_CERT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="${2:-}"
      shift 2
      ;;
    --lnd-dir)
      LND_DIR="${2:-}"
      shift 2
      ;;
    --lncli-bin)
      LNCLI_BIN="${2:-}"
      shift 2
      ;;
    --tlscertpath)
      TLS_CERT_PATH="${2:-}"
      shift 2
      ;;
    *)
      echo "Usage: scripts/lnd-health.sh --lnd-dir <path> [--network <mainnet|testnet|signet|regtest>] [--lncli-bin <path>] [--tlscertpath <path>]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$LND_DIR" ]]; then
  echo "Missing --lnd-dir" >&2
  exit 1
fi

if [[ -z "$TLS_CERT_PATH" ]]; then
  TLS_CERT_PATH="$LND_DIR/tls.cert"
fi

printf '[lncli] command=getinfo rpcserver=%s lnddir=%s tlscertpath=%s\n' "" "$LND_DIR" "$TLS_CERT_PATH" >&2

INFO_JSON="$("$LNCLI_BIN" --network="$NETWORK" --lnddir="$LND_DIR" --tlscertpath="$TLS_CERT_PATH" getinfo)"

printf '%s\n' "$INFO_JSON" | node --input-type=module -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const info = JSON.parse(input || "{}");
    const syncedToChain = info?.synced_to_chain === true;
    const syncedToGraph = info?.synced_to_graph === true;
    const numPeers = Number(info?.num_peers || 0);
    const status = syncedToChain && syncedToGraph && numPeers > 0 ? "ready" : "blocked";
    console.log(`synced_to_chain=${syncedToChain}`);
    console.log(`synced_to_graph=${syncedToGraph}`);
    console.log(`num_peers=${numPeers}`);
    console.log(`status=${status}`);
    if (status !== "ready") {
      console.log("DO NOT RUN SWAPS UNTIL THESE ARE TRUE");
    }
  });
'
