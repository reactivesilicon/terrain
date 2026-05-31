// Branded-symbol token. Kept for v0.1 because it is simple, collision-safe,
// and carries a debug name through Symbol.description. NOTE: switching to
// object tokens later would be a BREAKING API change for callers (all existing
// tokens are symbols) unless a compatibility bridge is added.
export type Token<T> = symbol & { readonly __type?: T };

export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}
