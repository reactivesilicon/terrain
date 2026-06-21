export const RESERVED_MODULE_NAMES = ["scope", "start", "dispose"] as const;
export type ReservedModuleName = (typeof RESERVED_MODULE_NAMES)[number];
