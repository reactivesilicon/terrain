import type { AnyToken } from "./token";

export function tokenName(token: AnyToken<any>): string {
  return token.description || "UnknownToken";
}

export function flattenErrors(errors: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const error of errors) {
    if (error instanceof AggregateError) out.push(...flattenErrors(error.errors));
    else out.push(error);
  }
  return out;
}
