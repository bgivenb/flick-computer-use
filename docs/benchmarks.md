# Reproducible measurements

Six consecutive Dispatch trials completed successfully, with **6.096 seconds median task time**, 13–14 UI actions each, and zero host interventions. These are measurements of a synthetic local productivity fixture. They do not establish speed or reliability on arbitrary websites.

| Trial | Scenario | Seconds | Actions | Jev calls | Saved-state checks |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 5.757 | 14 | 16 | 11/11 |
| 2 | 2 | 6.100 | 13 | 16 | 11/11 |
| 3 | 3 | 6.059 | 14 | 15 | 11/11 |
| 4 | 1 | 6.301 | 14 | 16 | 11/11 |
| 5 | 2 | 6.093 | 13 | 16 | 11/11 |
| 6 | 3 | 6.428 | 14 | 15 | 11/11 |

## Environment and method

- 2026-09-24T05:06:24.360Z; Apple M5 Pro, macOS 26.5.1, Node v26.3.0.
- Dedicated headless Playwright Chromium, local stdio MCP, live TypeSafe API, model alias `jev-latest`. The alias can change; an immutable model revision was not returned in this report.
- One session, six trials, three different requests repeated twice. The fixture resets between trials.
- The demo uses `minConfidence: 0.35`; the normal MCP default is `0.55`. Several form fields are valid next actions, and the demo separately verifies every saved field.
- Timings include observations, decisions, retries, actions, and the runner's completion checks. They exclude browser connection, countdown, fixture reset, and the additional saved-state check after each run.
- Every Jev request is counted, including reconsideration of unavailable field/value pairs. No host guidance, host clicks, or mid-run code edits occurred.
- The fixture has no real-site network latency. A visible recording can be slower.

The seven task values, task count, and three export settings are checked through the fixture's saved state, independently of Jev's answers. The runner's UI checks must also pass. The benchmark stops at its first failure and exits nonzero. This batch completed all six trials; no failed trials were omitted.

[Machine-readable results](benchmarks/dispatch.json) include every action, timing component, check, and a source fingerprint. Full local traces are saved under `.local/demo/batch-*.json`.

## Reproduce

```sh
node scripts/setup-agent.mjs
# Set TYPESAFE_API_KEY in .env.local.
npm run demo:bench
```

Use `npm run demo:record` for an actual-speed video. [Recording guide](demo.md).
