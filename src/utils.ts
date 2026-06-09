import type { AnyToken } from "./token";
import type { Disposable } from "./types";

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

export function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === "object" &&
    value !== null &&
    "dispose" in value &&
    typeof (value as Disposable).dispose === "function"
  );
}
