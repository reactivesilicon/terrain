# terrain — design & technical overview

This document explains the **decisions, guarantees, and limits** behind terrain — the
"why," not the "how-to." It is for readers who want a deeper understanding than the
[README](./README.md) usage guide gives, and for anyone evaluating terrain against
other dependency-injection libraries. It is intentionally not an implementation tour;
it describes behavior and rationale, not internals.

## Positioning

terrain is a TypeScript-first DI container with a **composition-first** model:

- **No decorators, no reflection, no runtime dependencies.** Wiring is plain code.
- **No service locator, no tokens in the public API.** You name modules and entries;
  resolution reads like an API (`app.Data.userRepo()`), and types flow from the
  providers themselves.
- **Wrong wiring fails loudly — and as much as possible at compile time.** What the
  type system can express is a compile error; everything else is a runtime backstop.
- **Composition is explicit and static.** You declare what each module `uses` and
  hand a fixed set of modules to a container. There is no global container and no
  ambient registration.

## Core design decisions

Each decision below names the trade-off it makes, so you can judge fit.

### No decorators or reflection

Decorator/reflection DI (the `reflect-metadata` style) infers dependencies from class
metadata. terrain rejects that: it requires no experimental compiler flags, no metadata
emit, and works on **any value** — classes, plain objects, functions, primitives — not
just decorated classes.

- **You get:** zero runtime magic, portability, and dependencies that are explicit and
  greppable in ordinary code.
- **You pay:** you wire constructors yourself inside providers (no automatic
  constructor injection). Wiring is more explicit and slightly more verbose.

### Names are the handles, not tokens

Most container libraries resolve by a token or string key (a service-locator call).
terrain exposes **module and entry names** as typed namespaces; tokens exist only as an
internal implementation currency you never touch.

- **You get:** call sites with no token plumbing and no casts; an entry's type is
  exactly its provider's return type, and that type appears everywhere the entry is used.
- **You pay:** "go to definition" on an accessor lands on a computed (mapped) type, not
  the provider — inherent to deriving the surface from types.

### Type-driven, with runtime backstops

terrain pushes correctness into the type system wherever the constraint is expressible,
and backstops the rest at runtime for dynamic/untyped callers.

- **Compile time:** the sync/async split, in-module ordering (an entry can only see
  entries defined before it), namespace exposure, reserved/identifier name rules, and
  unknown-name errors.
- **Runtime:** captive-dependency detection, circular-dependency detection for graphs
  built through escape hatches, duplicate names, and foreign (non-`createModule`) values.

This is the central difference from reflection-based containers, which discover most
errors only when resolution runs.

### Cycles are unrepresentable in typed code

- **In-module cycles** can't be written: a provider's resolver only exposes entries
  registered earlier in the chain, so an entry cannot reference itself or a later one.
- **Cross-module cycles** can't be written: `uses` only accepts modules that already
  exist, so a module cannot transitively depend on itself.

A cycle can still be forced through the runtime escape hatch (capturing the builder and
registering imperatively); that path is caught at resolution with a clear error. The
point is that _normal, typed_ code cannot express a cycle at all.

### Sync/async is a typed boundary

A synchronous provider's resolver exposes only the synchronous entries of its imports;
asynchronous entries are reachable only from asynchronous providers, and async accessors
return promises. Asynchronous construction can therefore never hide behind a synchronous
call.

- **You pay:** two method families (`single`/`singleAsync`, etc.) and an explicit choice
  per entry.

### Disposal is explicit and opt-in

Teardown runs only for entries that declared a `dispose` function — there is no
duck-typing of a `.dispose()`/`.close()` method. Disposal runs in **reverse creation
order** (dependents before dependencies), cascades to scopes, is idempotent, and
aggregates multiple failures into one `AggregateError`.

- **You get:** predictable teardown with no accidental disposal of objects that merely
  happen to have a `close()` method.
- **You pay:** you opt in per entry.

### Explicit exposure (encapsulation by construction)

A module's `uses` dependencies are wired transitively but **hidden**; only the modules
you pass to the container get a public namespace. Layer boundaries are a compile-time
fact, not a convention — a caller cannot reach past what the composition root exposes.

### Static composition

`createContainer` builds a fixed graph. There is no public runtime hot-swap or dynamic
module loading at the composition layer; the testing and reconfiguration model is "build
a fresh container" (cheap, isolated, and what overrides are for).

## What it guarantees

Properties terrain enforces, beyond resolving values:

- **Captive-dependency safety** — a singleton cannot depend on a scoped entry (it would
  outlive the scope it captured); detected at resolution.
- **Deterministic disposal** — reverse creation order, scope cascade, idempotent,
  errors aggregated rather than swallowed or lost.
- **Async coalescing** — concurrent resolution of the same async singleton yields a
  single shared instance, not one per caller.
- **Teardown-race safety** — a resolution that completes after its container/scope was
  disposed (or its module unloaded) is not cached and is disposed immediately rather
  than leaked; disposal errors from those orphans are observable via `onDisposeError`.
- **Exclusive lifecycle operations** — load/unload/dispose are mutually exclusive across
  a container tree, so structural changes can't interleave.
- **Tree disposal semantics** — disposing a container invalidates its whole subtree;
  a disposed container throws on use.
- **Name safety** — module and entry names are validated to identifiers (reserved view
  names excluded for modules); no name can collide with internal machinery or built-in
  object properties.

## Capabilities at a glance

- **Lifetimes:** singleton, factory (new per resolution), scoped (one per scope) — each
  in sync and async form.
- **Scopes:** nestable; a callback form that always disposes afterward (preserving body
  errors), and a manual form you dispose yourself.
- **Eager initialization:** mark singletons `eager` and call `start()` to construct them
  in parallel at boot, so failures surface at startup rather than first request.
- **Overrides:** derive a typed fake from a module (`Module.override`) and pass it to the
  container; it rewires every importer of the target without exposing a namespace.
  Entry names, value types, and sync/async mode are checked against the original.
- **Container options:** `createContainer({ options, parts })` accepts `onDisposeError`;
  scopes inherit it.
- **Version diamonds:** two importers can depend on different module objects that share a
  name, and each resolves its own; deduplication is by module identity.

## Limits & non-goals

Stated plainly, because they matter for evaluation:

- **No automatic/constructor injection.** You assemble dependencies explicitly in
  providers. This is a deliberate trade for zero reflection.
- **No multi-binding / collection injection.** An entry has exactly one provider;
  duplicate definitions are rejected. There is no "inject all implementations of X."
- **No optional resolution.** There is currently no `getOrNull`-style API; a missing
  dependency is an error.
- **Static composition only.** No public runtime module hot-swap; rebuild a container
  instead.
- **TypeScript-first.** The guardrails are types; used from plain JavaScript you keep the
  runtime backstops but lose the compile-time guarantees.
- **ESM-only, modern runtime.** Pure ES modules, no CommonJS build; targets Node ≥ 20.

## How to compare it to peers

DI libraries for TypeScript differ along a few axes. terrain's position on each:

| Axis                        | terrain                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| Dependency discovery        | Explicit wiring in providers (no decorators/reflection)                |
| Error timing                | Compile-time where expressible; runtime backstops otherwise            |
| Public resolution surface   | Named typed namespaces (no tokens/service locator at call sites)       |
| Runtime dependencies        | None                                                                   |
| Cycle handling              | Unrepresentable in typed code; runtime-detected through escape hatches |
| Async                       | First-class, separated from sync at the type level                     |
| Disposal                    | Explicit, opt-in, reverse-order, deterministic                         |
| Composition                 | Static, explicit exposure (enforced encapsulation)                     |
| Multi-binding / auto-wiring | Not supported (by design)                                              |

If your priorities are decorator ergonomics, automatic constructor injection, or
collection bindings, a reflection-based container will fit better. If your priorities are
zero runtime magic, types that flow from your code, errors caught early, and predictable
lifecycle/disposal, that is what terrain optimizes for.

## Runtime & packaging

- **Zero runtime dependencies**; side-effect-free and tree-shakeable.
- **ESM-only** build (`dist/index.js` + `dist/index.d.ts`); no decorators or metadata
  emit required in consumers.
- **Engine boundary:** the published surface is the composition layer plus framework
  errors. The lower-level token engine exists but is an internal implementation detail,
  not part of the supported public API.
