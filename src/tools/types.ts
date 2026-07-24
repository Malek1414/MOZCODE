export interface SavingsMeta {
  tool: string;
  path?: string;
  /** Tokens a naive built-in (Read/Grep) would have returned. */
  baselineTokens: number;
  /** Tokens Terse actually returned. */
  actualTokens: number;
  /** baselineTokens - actualTokens (never negative). */
  savedTokens: number;
}

export interface ToolResult {
  /** The payload shown to the model. */
  text: string;
  /** True when Terse fell back to a plain read instead of symbol extraction. */
  degraded: boolean;
  meta: SavingsMeta;
}

export function makeMeta(
  tool: string,
  path: string | undefined,
  baselineTokens: number,
  actualTokens: number,
): SavingsMeta {
  return {
    tool,
    path,
    baselineTokens,
    actualTokens,
    savedTokens: Math.max(0, baselineTokens - actualTokens),
  };
}
