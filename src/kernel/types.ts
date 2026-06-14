export type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type UnionToIntersection<U> = (U extends unknown ? (arg: U) => unknown : never) extends (arg: infer I) => unknown
  ? I
  : never;
