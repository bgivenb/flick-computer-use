# Record the demo

The headline workflow is a task and report configuration in Dispatch, a bundled synthetic productivity app. Jev chooses every UI action through the same stdio MCP and driver used by clients. The runner verifies the task's seven values, task count, and export's three values against the app's saved state.

[Watch the uncut recording](assets/demo.mp4): 14 actions, 16 Jev calls, 6.003 seconds task time, all eleven saved-state checks passing. Playback is 1×. The clip includes countdown and result hold; its total duration is 16.48 seconds. This visible recording is separate from the [six-trial benchmark](benchmarks.md).

## One command

```sh
npm run demo:record
```

This opens a disposable visible Chromium profile, counts down for four seconds, executes the task, leaves the result visible for five seconds, and closes its task browser. The uncut recording is `.local/demo/dispatch-demo.webm`; the final screenshot and JSON trace are in `.local/demo/`. Each batch keeps a timestamped JSON archive in addition to `latest.json`.

For your existing Chrome profile:

```sh
npm run demo:run -- --existing-chrome --hold
```

Enable remote debugging at `chrome://inspect/#remote-debugging` and click Chrome's Allow prompt when it appears. Record your screen for this mode; Playwright's built-in recording is available only for the disposable browser. Press Enter in the terminal to close the task tab after inspecting the result.

## A short video that explains itself

1. Show the request and the empty workspace during the countdown.
2. Let the whole task play at its actual speed. The timer and action log are live.
3. Hold on the independently verified result.
4. Finish with the repo name and the command to reproduce it.

Suggested narration: “One goal. Flick reads the controls, Jev picks the actions, and the local engine executes them. Task created, report configured, every saved value checked.”

The task timer excludes connection, countdown, fixture reset, and the independent post-run check. The local app has no real website loading delays. A recording can be slower than an unrecorded run; use its actual displayed time in the video.

## Repeatability

```sh
npm run demo:bench
```

Six runs cycle through three requests with different task titles, assignees, projects, dates, notes, export emails, and priorities. A run stops at the first failure and exits nonzero. The report includes every completed trial, all saved-data checks, model calls including repairs, action effects, and decision traces. No host continuation is used during a trial.

The demo explicitly uses `minConfidence: 0.35` because several unfinished fields can be equally valid next steps. The general MCP default remains `0.55`. Override it with `--min-confidence=0.55` to compare. This is a declared demo configuration, not a claim about acceptable thresholds for other tasks.

Other useful options:

```sh
npm run demo:run -- --headless --runs=3 --countdown=0
npm run demo:run -- --hold --countdown=10
```

Run `npm run demo` to open the workspace yourself and supply a different goal through your MCP client. The app stays local; saving export settings does not send email or upload data.
