# 0010 — The source runs unbuilt, so it obeys strip-only rules

**Status** accepted · 2026-08-31 · qualifies [0002](0002-typescript.md)

## Context

No package in this repository has a build step. Every `exports` entry points at
a `.ts` file, and everything that consumes them — the board through Turbopack,
`scripts/bootstrap.mjs` and the tests through Node — reads that source directly.

[0002](0002-typescript.md) chose TypeScript and said nothing about how it would
be loaded, because with a bundler it does not matter. It does under Node. Node
26 runs TypeScript by **stripping types**, not by transforming: it deletes the
annotations and leaves the rest of the file alone. Two things follow, and both
were discovered by running the code rather than by reading about it.

**Barrel files did not resolve.** `packages/*/src/index.ts` re-exported with
`.js` specifiers — the convention for TypeScript that will be compiled to `.js`.
There is no compile step here, so `./db.js` does not exist:

```
ERR_MODULE_NOT_FOUND Cannot find module …/packages/store/src/db.js
  imported from …/packages/store/src/index.ts
```

`tsc` never saw this, because `moduleResolution: bundler` maps `.js` back to
`.ts` for type-checking, and Turbopack does the same for the board. Both were
green. `import("@lingtai/store")` from Node was not. The three barrels were
the only files affected — every other import in the tree already used `.ts`.

**Parameter properties did not load.** `constructor(readonly streamId: string)`
is not an annotation; it is a declaration *and* an assignment that a compiler
has to generate. Strip-only mode refuses it outright:

```
ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX TypeScript parameter property is not
  supported in strip-only mode
```

## Decision

Every package's source stays directly runnable by Node, with no build step.
Concretely:

- **Relative imports carry `.ts`**, including in `index.ts` barrels. Not `.js`,
  not extensionless.
- **No syntax that requires a transform**: no constructor parameter properties,
  no `enum`, no `namespace`, no decorators, no `experimentalDecorators`.
  Type-only syntax is fine; anything that emits runtime code is not.

## Consequences

- `tsc --noEmit` and a board build are **not sufficient** to prove a package
  loads. Both resolve `.js` → `.ts` themselves. The cheap check that does prove
  it is `node -e "import('@lingtai/<pkg>')"`, run from inside that package
  or one that depends on it — worth having in
  `lingtai doctor` ([#5](https://github.com/steven-zhc/lingtai/issues/5)), since
  the conductor, the CLI and the hook all load this source through Node and the
  board does not.
- `enum` is barred, which costs nothing: the event catalogue is zod enums
  already, and they are values as well as types.
- Bun compiles the hook ([0002](0002-typescript.md)) and is a full transform, so
  the hook could break these rules. It should not — it is the file with the
  fewest reasons to be different from everything else.
- If a build step ever becomes necessary, this decision is what gets superseded,
  and the `.ts` specifiers are what has to change back.

## Note on method

The failing check was `import("@lingtai/store")` — a line written to confirm
something already believed true. Two commands, four packages green, and the
package could not be loaded. Worth repeating whenever a project's checks all run
through the same resolver.
