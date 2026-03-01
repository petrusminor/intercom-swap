# RUN TAO E2E (BTC<->TAO Settlement)

This runbook is copy/paste oriented for running maker + taker in `tao-evm` settlement mode.

## 1) Preconditions

- Tested baseline:
  - Node.js: `v22.15.0`
  - npm: `10.9.2`
- Run from repo root:
  - `~/intercom-swap`

Required TAO env:

```bash
cd ~/intercom-swap

export TAO_EVM_RPC_URL="https://lite.chain.opentensor.ai"
export TAO_EVM_PRIVATE_KEY="0x<your_32_byte_hex_private_key>"
export TAO_EVM_HTLC_ADDRESS="0x<deployed_tao_htlc_address>"
```

Warning:
- Use a fresh dev key with small funds only.
- Never reuse production keys/funds for smoke/E2E testing.
- Never print or commit private keys.

## 2) Deploy HTLC (if not already deployed)

If you do not already have a TAO HTLC address:

```bash
cd ~/intercom-swap/settlement/tao-evm
npm install
npx hardhat compile --config hardhat.config.js
npx hardhat run scripts/deploy.js --network tao --config hardhat.config.js
```

Set the deployed address:

```bash
cd ~/intercom-swap
export TAO_EVM_HTLC_ADDRESS="0x<deployed_address_from_deploy_output>"
```

## 3) TAO Provider Live Preflight (run before maker/taker)

Run these in order.

### 3a) Env/RPC/contract sanity (no tx)

```bash
cd ~/intercom-swap
node scripts/tao-env-check.mjs
```

Expected:
- `chain_id` is `964`
- signer address/balance are returned
- contract code exists at `TAO_EVM_HTLC_ADDRESS`
- ends with `PASS tao-env-check`

### 3b) TAO smoke (includes zero-value wallet tx)

```bash
cd ~/intercom-swap
npm run tao:smoke
```

Expected:
- `tao_chain` with chain_id `964`
- `tao_wallet` and `tao_balance`
- tx send + confirmation lines

### 3c) Provider HTLC roundtrip (lock -> verify -> claim)

```bash
cd ~/intercom-swap
node settlement/tao-evm/scripts/provider-htlc-roundtrip.mjs
```

Expected:
- `provider_lock_ok`
- `provider_verify_ok`
- `provider_claim_ok`
- final line: `PASS provider-htlc-roundtrip`

Common failures:
- DNS/RPC resolution issues:
  - example: `getaddrinfo ENOTFOUND ...`
  - action: verify host reachability and network/DNS.
- Wrong chain:
  - `Wrong chainId: expected 964 got ...`
  - action: fix `TAO_EVM_RPC_URL`.
- Insufficient funds/gas:
  - action: fund the TAO signer from `TAO_EVM_PRIVATE_KEY`.
- Wrong HTLC address:
  - action: verify `TAO_EVM_HTLC_ADDRESS` points to deployed contract.

## 4) Run Peer + RFQ Bots in TAO Mode

Peer must be running before bot wrappers.

Reference peer starters:
- `scripts/run-swap-maker.sh`
- `scripts/run-swap-taker.sh`
- or background peer manager `scripts/peermgr.sh`

Example terminals:

Terminal A (maker peer):

```bash
cd ~/intercom-swap
scripts/run-swap-maker.sh swap-maker 49222 0000intercomswapbtctao
```

Terminal B (taker peer):

```bash
cd ~/intercom-swap
export SWAP_INVITER_KEYS="<maker_peer_pubkey_hex32>"
scripts/run-swap-taker.sh swap-taker 49223 0000intercomswapbtctao
```

Terminal C (maker RFQ bot in TAO settlement mode):

```bash
cd ~/intercom-swap
scripts/rfq-maker-peer.sh swap-maker 49222 \
  --rfq-channel 0000intercomswapbtctao \
  --run-swap 1 \
  --settlement tao-evm \
  --ln-impl cln \
  --ln-backend docker \
  --ln-service cln-alice \
  --settlement-refund-after-sec 259200
```

Terminal D (taker RFQ bot in TAO settlement mode):

```bash
cd ~/intercom-swap
scripts/rfq-taker-peer.sh swap-taker 49223 \
  --rfq-channel 0000intercomswapbtctao \
  --run-swap 1 \
  --settlement tao-evm \
  --ln-impl cln \
  --ln-backend docker \
  --ln-service cln-bob \
  --btc-sats 50000 \
  --tao-amount-atomic 100000000
```

What these wrappers resolve automatically:
- SC token file:
  - `onchain/sc-bridge/<store>.token`
- peer keypair:
  - `stores/<store>/db/keypair.json`
- receipts:
  - maker: `onchain/receipts/rfq-bots/<store>/maker.sqlite`
  - taker: `onchain/receipts/rfq-bots/<store>/taker.sqlite`

Logs/events to look for:
- maker lock event:
  - `TAO_HTLC_LOCKED` / `tao_htlc_locked_sent`
- taker pre-pay verification success:
  - `verifySwapPrePayOnchain` passes
- LN pay occurs only after verify
- taker claim event:
  - `TAO_CLAIMED` / `tao_claimed_sent`

## 5) promptd TAO Mode

Start promptd in TAO settlement mode:

```bash
cd ~/intercom-swap
node scripts/promptd.mjs --config onchain/prompt/setup.json --settlement tao-evm
```

Swap tool path (prompt executor):
- `intercomswap_quote_accept`
- `intercomswap_swap_sol_escrow_init_and_post` (emits TAO lock in TAO mode)
- `intercomswap_swap_verify_pre_pay`
- `intercomswap_swap_ln_pay_and_post_verified` (or pay-from-invoice path)
- `intercomswap_swap_sol_claim_and_post`
- `intercomswap_swap_sol_refund_and_post`

Envelope expectations by settlement mode:
- TAO mode:
  - `TAO_HTLC_LOCKED`
  - `TAO_CLAIMED`
  - `TAO_REFUNDED`
- SOL mode:
  - `SOL_ESCROW_CREATED`
  - `SOL_CLAIMED`
  - `SOL_REFUNDED`

Example TAO offer announcement payload (`intercomswap_offer_post`):

```json
{
  "channels": ["0000intercomswapbtctao"],
  "name": "maker:tao",
  "rfq_channels": ["0000intercomswapbtctao"],
  "offers": [
    {
      "pair": "BTC_LN/TAO_EVM",
      "have": "TAO_EVM",
      "want": "BTC_LN",
      "btc_sats": 50000,
      "tao_amount_atomic": "100000000",
      "max_platform_fee_bps": 10,
      "max_trade_fee_bps": 10,
      "max_total_fee_bps": 20,
      "settlement_refund_after_sec": 259200
    }
  ]
}
```

Example promptd maker-side TAO offer command:

```bash
cd ~/intercom-swap
curl -sS http://127.0.0.1:7700/v1/run \
  -H "authorization: Bearer <promptd_token>" \
  -H "content-type: application/json" \
  -d '{
    "auto_approve": true,
    "max_steps": 1,
    "prompt": "{\"type\":\"tool\",\"name\":\"intercomswap_offer_post\",\"arguments\":{\"channels\":[\"0000intercomswapbtctao\"],\"name\":\"maker:tao\",\"rfq_channels\":[\"0000intercomswapbtctao\"],\"offers\":[{\"pair\":\"BTC_LN/TAO_EVM\",\"have\":\"TAO_EVM\",\"want\":\"BTC_LN\",\"btc_sats\":50000,\"tao_amount_atomic\":\"100000000\",\"max_platform_fee_bps\":10,\"max_trade_fee_bps\":10,\"max_total_fee_bps\":20,\"settlement_refund_after_sec\":259200}]}}"
  }'
```

Pair-aware offers are now the base pattern for future settlement assets:
- `BTC_LN/USDT_SOL` keeps the legacy USDT + Solana fields.
- `BTC_LN/TAO_EVM` uses `tao_amount_atomic` + `settlement_refund_after_sec`.

## 6) Receipts + Recovery (TAO)

Receipts locations:
- RFQ bot wrappers:
  - `onchain/receipts/rfq-bots/<store>/maker.sqlite`
  - `onchain/receipts/rfq-bots/<store>/taker.sqlite`
- promptd:
  - from `receipts.db` in `onchain/prompt/setup.json`

TAO fields expected in receipts:
- `settlement_kind = "tao-evm"`
- `tao_settlement_id`
- `tao_htlc_address`
- `tao_amount_atomic`
- `tao_recipient`
- `tao_refund`
- `tao_refund_after_unix`
- `tao_lock_tx_id`
- `tao_claim_tx_id` (after claim)
- `tao_refund_tx_id` (after refund)
- `ln_payment_hash_hex` link key

swaprecover examples (TAO):

```bash
cd ~/intercom-swap

# Status / inspect
node scripts/swaprecover.mjs status \
  --receipts-db onchain/receipts/rfq-bots/swap-maker/maker.sqlite \
  --trade-id <trade_id> \
  --settlement tao-evm

# Claim
node scripts/swaprecover.mjs claim \
  --receipts-db onchain/receipts/rfq-bots/swap-maker/maker.sqlite \
  --trade-id <trade_id> \
  --settlement tao-evm

# Refund
node scripts/swaprecover.mjs refund \
  --receipts-db onchain/receipts/rfq-bots/swap-maker/maker.sqlite \
  --trade-id <trade_id> \
  --settlement tao-evm
```

swaprecover SOL status example (for mixed environments / legacy SOL rows):

```bash
cd ~/intercom-swap
node scripts/swaprecover.mjs status \
  --receipts-db onchain/receipts/rfq-bots/swap-maker/maker.sqlite \
  --trade-id <trade_id> \
  --settlement solana \
  --solana-rpc-url http://127.0.0.1:8899 \
  --solana-keypair stores/swap-maker/db/keypair.json
```

TAO env required for TAO recovery:
- `TAO_EVM_RPC_URL`
- `TAO_EVM_PRIVATE_KEY`
- `TAO_EVM_HTLC_ADDRESS`

Note on improved error guidance:
- `swaprecover status|inspect` now prints clearer missing-flag/env messages
  (for example missing `TAO_EVM_PRIVATE_KEY` or missing Solana signer flags).
- Current behavior: `swaprecover status|inspect` on SOL requires signer flags:
  - `--solana-rpc-url`
  - `--solana-keypair`

## 7) Safety Checklist

Before any live swap:
- Confirm TAO chain id:
  - must be `964`
- Confirm HTLC address:
  - `TAO_EVM_HTLC_ADDRESS` matches deployment
  - non-empty contract code at that address
- Confirm pre-pay verification protections:
  - `verifySwapPrePayOnchain` checks:
    - hashlock/payment hash match
    - amount match
    - refund timelock match
    - recipient/refund address match
    - HTLC address match
- Confirm refund timing alignment:
  - `sol_refund_after_unix` / TAO refund timelock must leave enough room beyond LN invoice expiry and routing retries
  - avoid overly short refund windows

If anything above is not green, do not run swap settlement.
