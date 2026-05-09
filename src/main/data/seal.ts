import { createHmac } from 'node:crypto';

/**
 * Tamper-resistance for the cumulative token count and current level.
 *
 * **Threat model**: a casual user opens `~/.nom/state.json` in TextEdit and
 * cranks `cumulative` to 999_999_999_999 to insta-flex 战神. We HMAC-sign
 * the relevant fields with a key embedded in the app binary; any edit that
 * doesn't also recompute the signature gets caught on next load and resets
 * cumulative + level back to a clean baseline.
 *
 * **Not in scope**: a determined attacker who runs `strings nom.app` will
 * extract SEAL_SECRET and re-sign forged values. Defending against that
 * requires server-side validation, which conflicts with nom's "zero-network"
 * privacy stance. We accept this gap — the goal is to deter casual cheating,
 * not stop a security researcher.
 */

const SEAL_SECRET = 'nom-pet:hmac-v1:b7d3e2c1-4a89-4f7e-93b6-ee2d1f0c8a55';

export interface SealedFields {
  cumulative: number;
  lastLevelIndex: number;
}

export function computeSeal(fields: SealedFields): string {
  const payload = `nom:v1:${fields.cumulative}|${fields.lastLevelIndex}`;
  return createHmac('sha256', SEAL_SECRET).update(payload).digest('hex');
}

export function verifySeal(fields: SealedFields, seal: string | undefined | null): boolean {
  if (!seal || typeof seal !== 'string') return false;
  return computeSeal(fields) === seal;
}
