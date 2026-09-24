# Contributing to Flick

Start with a reproducible failure or a small capability that generalizes across apps. Browser control is the most mature path; native macOS control is experimental.

```sh
node scripts/setup-agent.mjs
npm test
```

The default suite uses disposable fixtures and requires no API key. Native helpers need macOS and Xcode Command Line Tools. Live tests and the demo need your own TypeSafe API key in `.env.local`.

## Changes we can evaluate

- Give the triggering state, expected outcome, observed outcome, and relevant trace.
- Keep observations and action candidates consistent. An action must refer to a control that was actually observed.
- Check target identity before acting. Preserve cancellation and ownership of native desktop sessions.
- Keep model output typed. Never turn generated selectors, JavaScript, or shell text into executable actions.
- Verify results through the application. A model's completion claim alone is insufficient.
- Count retries and additional model calls. Benchmark complete tasks and report failures alongside successes.
- Keep credentials, browser profiles, screenshots of personal apps, and private documents out of commits and issues.

For provider changes, read the current [TypeSafe documentation](https://docs.typesafe.ai/llms.txt), including the relevant primitive and question guidance. Confidence measures uncertainty among offered choices; it is not proof that an action or workflow is correct.

## Validation

`npm test` covers the runner, decision contract, DOM execution, stdio MCP, cross-app state, and independent demo verification. `npm run test:menu` checks native menus and OCR geometry without a model call. `npm run demo:bench` runs six paid Jev trials across three synthetic requests.

Keep a benchmark build fixed during a run. Save the trace and change the code between runs. Include connection mode, scenario, machine, model version, confidence setting, and excluded setup time when sharing numbers.

Contributions are accepted under the project's MIT license.
