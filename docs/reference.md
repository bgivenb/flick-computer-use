# Architecture and tool reference

Flick runs an MCP server over stdio. There is no HTTP listener or separate Flick account. Its local runner retains browser/native connections across calls and can execute a whole goal without returning to the host assistant for each action.

The demo app has its own localhost HTTP server, separate from the MCP transport.

## Browser session

```json
{
  "kind": "browser",
  "connection": "existing-chrome",
  "url": "http://127.0.0.1:YOUR_DEMO_PORT"
}
```

Pass this to `computer_open`. Existing-Chrome mode discovers the standard Chrome debugging endpoint on macOS, asks Chrome to connect, and creates a task tab. Page routing and dialog handling are scoped to owned pages. Closing the session closes its task tabs and disconnects without closing the user's browser context. The user operates Chrome's approval dialog.

Omit `connection` for a dedicated persistent Playwright profile. `browser: "chrome"` selects installed Google Chrome; the default is Chromium. `profile` names an isolated directory under `.local/browser-profiles`. Browser tasks can navigate across sites by default. Supplying a nonempty `allowedOrigins` list opts into restricting document navigation to the starting origin and listed origins; asset/API subresources remain unrestricted.

Existing-Chrome tasks reuse one Chrome-approved debugging connection across task tabs in the same MCP process. Closing a task closes its tabs; stopping the MCP process disconnects from Chrome. Chrome may ask for permission again after that process restarts.

`recordVideo: true` records dedicated-browser sessions into `.local/recordings`; it is unsupported on an existing-Chrome connection. The video is finalized when the session closes.

## Run a goal

```json
{
  "sessionId": "SESSION_ID",
  "goal": "Set the export email, choose CSV, include column headers, and save.",
  "inputs": { "email": "team@example.com" },
  "until": [
    { "kind": "text", "text": "Export settings saved" },
    { "kind": "field", "name": "Export email", "value": "team@example.com" },
    { "kind": "field", "name": "File format", "value": "csv" },
    { "kind": "checked", "name": "Include column headers", "checked": true }
  ]
}
```

Pass this to `computer_run`. It returns a task ID. `computer_status` can wait up to 20 seconds for completion; callers can also request immediate snapshots. Defaults: 25 actions, 60 seconds, 0.55 Choice confidence. These are prototype defaults, not reliability guarantees.

Statuses are `running`, `succeeded`, `blocked`, `failed`, `cancelled`, and `timed_out`. Every requested condition must pass. Failed or incomplete tasks can receive exact missing values and guidance through `computer_continue`; the existing session remains available.

Use `computer_cancel` and wait for a terminal status before closing a busy session. An already-started input operation may finish. MCP shutdown cancels tasks and closes owned resources.

## Cross-app goals

`computer_execute` takes a goal, inputs, completion conditions, and an available-target catalog. Targets are possible destinations, not a prescribed click sequence:

```json
{
  "goal": "Copy the reference from the source document into the destination form.",
  "targets": [
    { "kind": "macos", "bundleId": "com.apple.TextEdit", "name": "Source notes" },
    { "kind": "browser", "name": "Destination", "url": "http://127.0.0.1:YOUR_DEMO_PORT", "connection": "existing-chrome" }
  ],
  "until": [
    { "kind": "text", "text": "Transfer saved" }
  ]
}
```

This is a schema example; the app must actually expose the indicated source, destination, and success evidence. The demo does not implement this transfer form. For real tasks, choose conditions that verify the destination values as well as a saved message.

Jev can remember exact observed text and reuse it in another app. Memory is bounded to 12 facts of up to 10,000 characters. `field_from_memory` compares a destination field with an exact remembered source. Free-form text generation and arbitrary transformations remain host responsibilities.

`computer_workflow` is a separate convenience for a caller-specified sequence of native stages. Mixed browser/native stage plans have not been added to that tool.

## Tools

| Tool | Purpose |
| --- | --- |
| `computer_health` | Setup, native permissions, model configuration |
| `computer_open` | Browser or native session |
| `computer_sessions` | Owned sessions and busy state |
| `computer_apps` | Running or installed Mac apps |
| `computer_inspect` | Observed controls, exact values, IDs |
| `computer_act` | One typed action against an observation |
| `computer_run` | A goal in an existing session |
| `computer_execute` | A goal across available apps |
| `computer_continue` | Guidance/values for an unfinished task |
| `computer_workflow` | Ordered native stages |
| `computer_status` | Task result, metrics, events, optional observation |
| `computer_cancel` | Cancel remaining work |
| `computer_screenshot` | Browser tab/native window PNG for the host |
| `computer_copy_image` | Render an observed browser image as PNG; optionally copy it |
| `computer_close` | Close an idle session's owned resources |

Image copying captures the displayed image, not necessarily its original resolution. It is currently an explicit MCP tool, not an autonomous Jev action candidate.

## Native driver

`computer_open` accepts `kind: "macos"`, an app `bundleId`, and `ocr: "auto" | "always" | "off"`. The Swift helper walks Accessibility controls, retains target identity, executes AX actions or pointer/key fallbacks, and can use Apple Vision to read screen text.

Clicks support left/right/middle buttons and single/double click counts. OCR reads labels; it does not recognize the subjects of photographs. Normal native controls should be handled through Accessibility.

One native session owns the desktop at a time, including between app switches and host handoffs. A focus change can stop execution to prevent typing into another app. Native observation can expose transient states while menus dismiss or clipboard updates arrive; callers must verify the resulting state.

## Data and traces

Credentials load from ignored `.env.local`; `JEV_ENV_FILE` selects another file and `JEV_DATA_DIR` selects a local data directory. Never include credentials in MCP config, benchmark reports, or source commits.

Jev receives the goal, supplied inputs, selected interface text and controls, memory, and recent effects. Standard password/OTP values are redacted, but ordinary page text is not comprehensively scrubbed of personal information. Task events and traces can contain typed values. Automatic privacy-preserving trace export is not implemented.

The bundled demo persists reports only for its synthetic data. The server otherwise retains bounded task history in process memory. Restarting the MCP does not automatically replay unfinished writes.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/core/` | Task loop, observations/actions, scenes, memory coordination |
| `src/providers/` | TypeSafe decisions and bounded repair |
| `src/drivers/` | DOM and native adapters |
| `src/server.ts` | MCP tool contracts |
| `native/` | Swift helper |
| `demo/` | Independent synthetic productivity app |
| `scripts/` | Setup, demonstrations, recordings, live checks |
| `tests/` | Deterministic tests and disposable fixtures |
