/**
 * Cheap, deterministic token estimate. Deliberately simple: ~4 chars/token.
 * This is an ESTIMATE for savings accounting, never a billing figure.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
