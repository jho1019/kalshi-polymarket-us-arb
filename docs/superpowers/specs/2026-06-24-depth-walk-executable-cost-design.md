# Depth-walk executable cost function

Design for GitHub issue #7 (`phase:edge-calc`), the first edge-calc issue.

## Context: the engine already exists

`executableCost(asks, sizeQtyUnits)` in `src/book.ts` (built in #4) already walks
ask levels best-first, accumulating `price × qty`, and returns
`Fill { fillable, filledSize, totalCost, avgCost, levelsConsumed }`. `avgCost` is
the rounded weighted average price/contract (1/10000-$ units).

The only gap vs issue #7's literal contract ("return avg price/contract … or
`null` if it can't fill") is that `executableCost` returns the *partial* `avgCost`
with `fillable: false` on an oversized request — it never returns `null` for the
price. So issue #7 is: (1) a thin `null`-returning accessor, and (2) unit tests —
this is the phase where CLAUDE.md says the test runner arrives.

## 1. `avgFillPrice` accessor — `src/book.ts`

```ts
export function avgFillPrice(asks: Level[], sizeQtyUnits: number): number | null {
  const fill = executableCost(asks, sizeQtyUnits);
  return fill.fillable ? fill.avgCost : null;
}
```

Returns the rounded weighted avg price/contract when fully fillable, else `null`.
`executableCost` is unchanged — it stays the richer engine (partial-fill info for
the logger); `avgFillPrice` is the simple "avg or null" the edge math will call.

## 2. Test runner — `node:test` + `npm test`

- `node:test` + `node:assert` via tsx — zero new dependencies, matching the
  project's minimal-deps style.
- `package.json`: add `"test": "tsx --test \"src/**/*.test.ts\""` (Node 22's test
  runner expands the glob).
- Keep tests out of `dist`: add `tsconfig.build.json` extending `tsconfig.json`
  with `"exclude": ["node_modules", "dist", "**/*.test.ts"]`; point
  `"build": "tsc -p tsconfig.build.json"`. `typecheck` keeps using the base
  config, so test files are still type-checked.

## 3. Tests — `src/book.test.ts` (issue verify items)

Pure, deterministic, hand-built `Level[]` (integer 1/10000 units):

- **Single level, known avg:** asks `[{price:5000, qty:10·QTY}]`, size 10 →
  `avgFillPrice` = 5000.
- **Multi-level weighted average:** asks `[{100,10},{200,10}]`, size 15 →
  `(100·10 + 200·5)/15 = 133` (rounded). Also assert `executableCost.totalCost`
  and `filledSize` for the same case.
- **Beyond total depth:** size > sum(qty) → `avgFillPrice` returns `null`, and
  `executableCost(...).fillable === false` with `filledSize` = total depth.
- **Edge cases:** empty book → `null`; size 0 → `null` (not fillable).

Sizes/quantities are expressed in 1/10000-contract units via `QTY_SCALE` so the
tests read in whole contracts.

## Error handling

`avgFillPrice` and `executableCost` are total functions (no throws) — unfillable
is a return value, not an error, per #4's "unfillable, not a crash" rule.

## Out of scope

Fees/rebates, net edge across venues, and wiring cost into a spread calculation
(later edge-calc issues). This issue is the depth-walk accessor + its tests only.
