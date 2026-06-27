# Feed-Staleness Alerting + Heartbeat (Issue #16)

## Summary

Add three ops-safety behaviors to `src/logger/run.ts` so the read-only logger
signals liveness and rejects untrustworthy data:

1. **Heartbeat** — one console line per tick to prove the loop is alive.
2. **Feed-staleness alerting** — immediate stderr alert when any venue's WS drops;
   recovery notice when it comes back.
3. **Stale data exclusion** — raw captures are still written (flagged), but stale
   captures never produce opportunity records.

All changes are self-contained to `src/logger/run.ts`. No new files, no new
interfaces, no changes to `FeedClient`.

## Heartbeat

At the top of `tick()`, before iterating pairs:

```ts
console.log("[logger] heartbeat", new Date(captureMs).toISOString());
```

One line per cycle (default 1 s). Running `tail -f` on the terminal is sufficient
to confirm the logger is alive.

## Feed-Staleness Alerting

Add `venueStale = new Map<Venue, boolean>()` in `runLogger`. In the existing
`onUpdate` handler, after caching the snapshot, check the prior state:

```ts
const prev = venueStale.get(u.snapshot.venue) ?? false;
if (u.stale && !prev) {
  console.error(`[logger] ALERT: ${u.snapshot.venue} feed stale at ${new Date(u.snapshot.tsLocalMs).toISOString()}`);
  venueStale.set(u.snapshot.venue, true);
} else if (!u.stale && prev) {
  console.log(`[logger] RECOVERED: ${u.snapshot.venue} feed recovered`);
  venueStale.set(u.snapshot.venue, false);
}
```

Both feeds emit stale `FeedUpdate`s the moment their WS closes (before the
reconnect backoff starts), so the alert fires within one event emission — well
under 1 s after the drop, not gated to the next tick.

Recovery fires on the first non-stale update after a stale period. For Kalshi this
is per-ticker (each fresh snapshot clears stale for that ticker); the first one to
recover triggers the log. For PM it's per-slug.

## Stale Data Exclusion

In `tick()`, always append the raw `CaptureRecord` (it carries `legA.stale` and
`legB.stale` for post-hoc analysis). Only compute and append the `StoredOpportunity`
when both legs are fresh:

```ts
appendRecord(rawPath(opts.dataDir, date), record);
if (!record.legA.stale && !record.legB.stale) {
  const opp = computeOpportunity(record, DEFAULT_FEE_CONFIG);
  appendRecord(oppsPath(opts.dataDir, date), opp);
}
```

## Verification Criteria (from issue)

| Criterion | How it is met |
|---|---|
| Heartbeat logged each cycle | `console.log("[logger] heartbeat …")` at tick start |
| Killing a venue feed triggers alert within N seconds | Alert fires in `onUpdate` on the first stale emission, before the next tick |
| Stale data flagged/excluded, not logged as opportunities | Raw capture always written; opp skipped when `legA.stale \|\| legB.stale` |

## Files Changed

- `src/logger/run.ts` — only file touched
