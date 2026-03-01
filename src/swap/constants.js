export const SWAP_PROTOCOL_VERSION = 1;

export const ASSET = Object.freeze({
  BTC_LN: 'BTC_LN',
  USDT_SOL: 'USDT_SOL',
  TAO_EVM: 'TAO_EVM',
});

export const PAIR = Object.freeze({
  BTC_LN__USDT_SOL: 'BTC_LN/USDT_SOL',
  BTC_LN__TAO_EVM: 'BTC_LN/TAO_EVM',
});

export const DIR = Object.freeze({
  BTC_LN__TO__USDT_SOL: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
  BTC_LN__TO__TAO_EVM: `${ASSET.BTC_LN}->${ASSET.TAO_EVM}`,
});

export const KIND = Object.freeze({
  SVC_ANNOUNCE: 'swap.svc_announce',
  RFQ: 'swap.rfq',
  QUOTE: 'swap.quote',
  QUOTE_ACCEPT: 'swap.quote_accept',
  SWAP_INVITE: 'swap.swap_invite',

  TERMS: 'swap.terms',
  ACCEPT: 'swap.accept',
  CANCEL: 'swap.cancel',
  STATUS: 'swap.status',

  LN_INVOICE: 'swap.ln_invoice',
  SOL_ESCROW_CREATED: 'swap.sol_escrow_created',
  TAO_HTLC_LOCKED: 'swap.tao_htlc_locked',
  LN_PAID: 'swap.ln_paid',
  SOL_CLAIMED: 'swap.sol_claimed',
  TAO_CLAIMED: 'swap.tao_claimed',
  SOL_REFUNDED: 'swap.sol_refunded',
  TAO_REFUNDED: 'swap.tao_refunded',
});

export const STATE = Object.freeze({
  INIT: 'init',
  TERMS: 'terms',
  ACCEPTED: 'accepted',
  INVOICE: 'invoice',
  ESCROW: 'escrow',
  LN_PAID: 'ln_paid',
  CLAIMED: 'claimed',
  REFUNDED: 'refunded',
  CANCELED: 'canceled',
});
