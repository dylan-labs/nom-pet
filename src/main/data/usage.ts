/**
 * Token weighting for Anthropic usage objects.
 *
 * The 5 buckets in `usage` (input, output, cache_creation_5m, cache_creation_1h,
 * cache_read) have different prices. Their per-token-cost ratios (relative to
 * the input-token rate) are constant across Sonnet / Opus / Haiku — only the
 * absolute USD changes per model. So this weighted sum gives a model-agnostic
 * "input-token-equivalent" number that fairly reflects the *amount of AI work*
 * done in a turn.
 *
 * Source: Anthropic public pricing as of 2025-2026. If Anthropic changes the
 * price ratios, update WEIGHTS.
 *
 * For a turn with `cache_creation` sub-fields missing (older transcripts),
 * we fall back to treating all cache_creation as 5m tier.
 */

export const WEIGHTS = {
  input: 1.0,
  output: 5.0,
  cacheCreate5m: 1.25,
  cacheCreate1h: 2.0,
  cacheRead: 0.1,
} as const;

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export function computeWeightedTokens(usage: AnthropicUsage): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  // Prefer per-tier sub-fields; fall back to flat total as 5m if absent.
  const create5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  const create1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  let weightedCreate: number;
  if (create5m != null || create1h != null) {
    weightedCreate = (create5m ?? 0) * WEIGHTS.cacheCreate5m
                   + (create1h ?? 0) * WEIGHTS.cacheCreate1h;
  } else {
    weightedCreate = (usage.cache_creation_input_tokens ?? 0) * WEIGHTS.cacheCreate5m;
  }

  return Math.round(
    input * WEIGHTS.input
    + output * WEIGHTS.output
    + weightedCreate
    + cacheRead * WEIGHTS.cacheRead,
  );
}
