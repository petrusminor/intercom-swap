import { sha256Hex } from './hash.js';

// Human-readable app tag used in the on-wire protocol and docs.
// This is intentionally stable and should only change with a breaking protocol/product change.
export const INTERCOMSWAP_APP_TAG = 'intercomswapbtcusdt';

export function deriveIntercomswapAppHash({ solanaProgramId, appTag = INTERCOMSWAP_APP_TAG } = {}) {
  const program = String(solanaProgramId || '').trim();
  const tag = String(appTag || '').trim().toLowerCase();
  if (!program) throw new Error('deriveIntercomswapAppHash: solanaProgramId is required');
  if (!tag) throw new Error('deriveIntercomswapAppHash: appTag is required');

  // Stable, unambiguous canonical string. Do not change without a protocol version bump.
  const canon = `app=${tag};solana_program=${program}`;
  return sha256Hex(canon);
}

export function deriveIntercomswapAppHashForBinding(binding, { appTag = INTERCOMSWAP_APP_TAG } = {}) {
  const bindingId = String(binding?.binding_id || '').trim();
  if (!bindingId) throw new Error('deriveIntercomswapAppHashForBinding: binding.binding_id is required');
  return deriveIntercomswapAppHash({ solanaProgramId: bindingId, appTag });
}
