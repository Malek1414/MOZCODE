import { countTokens as bpeCountTokens } from "gpt-tokenizer/encoding/o200k_base";

/**
 * Token count used for savings accounting.
 *
 * MOZCODE uses o200k_base (the modern GPT-4o/o-series BPE) as a fast,
 * deterministic proxy — far better than a chars/token heuristic. It is NOT a
 * Claude token count, and no fixed accuracy bound is claimed: the two are
 * different tokenizers and per-workload error varies (Anthropic notes counts
 * can differ substantially across model generations). Anthropic's count_tokens
 * endpoint is the best model-specific measure but is itself an estimate, and is
 * networked/rate-limited — unsuitable for this hot path. If a model-specific
 * bound is ever needed, calibrate it offline against that endpoint. Every figure
 * here is an ESTIMATE against a counterfactual, never a billing statement.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return bpeCountTokens(text);
  } catch {
    // Tokenization must never throw into a tool's request path. Fall back to the
    // classic ~4 chars/token heuristic if the BPE encoder is ever unavailable.
    return Math.ceil(text.length / 4);
  }
}
