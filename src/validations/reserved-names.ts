export const RESERVED_MODULE_NAMES = ["scope", "start", "dispose"] as const;
export type ReservedModuleName = (typeof RESERVED_MODULE_NAMES)[number];

// `await` treats any object with a callable `then` as a promise, so an entry
// named `then` would make its namespace hang when awaited.
export const RESERVED_ENTRY_NAMES = ["then"] as const;
export type ReservedEntryName = (typeof RESERVED_ENTRY_NAMES)[number];
