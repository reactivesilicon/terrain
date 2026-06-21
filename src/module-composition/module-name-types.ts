import type { ReservedModuleName } from "../validations/reserved-module-names";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type LowercaseAsciiLetter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type AsciiLetter = LowercaseAsciiLetter | Uppercase<LowercaseAsciiLetter>;
type IdentifierStart = AsciiLetter | "_" | "$";
type IdentifierPart = IdentifierStart | Digit;

type IdentifierTailIsValid<Name extends string> = Name extends ""
  ? true
  : Name extends `${infer First}${infer Rest}`
    ? First extends IdentifierPart
      ? IdentifierTailIsValid<Rest>
      : false
    : false;

type IdentifierName<Name extends string> = string extends Name
  ? Name
  : Name extends `${infer First}${infer Rest}`
    ? First extends IdentifierStart
      ? IdentifierTailIsValid<Rest> extends true
        ? Name
        : never
      : never
    : never;

export type PublicModuleName<Name extends string> = Name extends ReservedModuleName ? never : IdentifierName<Name>;
export type PublicModuleEntryName<Name extends string> = IdentifierName<Name>;
