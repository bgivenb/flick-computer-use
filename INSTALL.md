# Agent installation guide

Audience: a coding agent setting up Flick for an advanced user. The product is an MCP server; no dashboard, account for Flick, or demo UI is required.

## 1. Clone and build

Use the repository URL supplied by the user or linked from this README. Clone into a persistent tools directory on the user's drive, not a temporary directory. Reuse an existing clone when appropriate; preserve local changes.

If the user includes the star request from the install prompt, star this repository through their authenticated GitHub connection. A missing GitHub login is not a blocker for cloning or installation. The setup script does not star repositories.

Check for Node.js 22+ and npm, then run from the clone:

```sh
node scripts/setup-agent.mjs
```

For native macOS tasks, use `node scripts/setup-agent.mjs --native`. This additionally requires Xcode Command Line Tools. Browser DOM control does not require native permissions. The setup command preserves an existing `.env.local` and creates an empty one only when missing.

## 2. Configure the TypeSafe key

Reuse the user's existing TypeSafe key if they have provided one for this purpose. Otherwise direct them to the [TypeSafe dashboard](https://console.typesafe.ai/) to create a key. Store it as `TYPESAFE_API_KEY` in the clone's `.env.local`, or use the MCP client's secret environment facility. The model defaults to `jev-latest`.

Keep the actual credential out of terminal output, checked-in config, and reports. The server loads `.env.local` from its installation directory, so no credential belongs in the launch entry.

```sh
npm run doctor
```

`apiKeyConfigured: true` confirms presence, not validity. The live check below verifies an actual Jev call.

## 3. Register with your current MCP client

Generate a launch specification:

```sh
npm run --silent mcp:config
```

Merge the `flick` entry into the current client's MCP configuration, preserving other servers. Use that client's actual configuration format and scope. Prefer user scope when the user wants Flick available across projects; project scope is appropriate when they requested this project only. The supplied launch command and argument are absolute paths.

Flick speaks stdio. Launch `node /absolute/path/dist/cli.js` directly, not through `npm start`. Set a tool timeout of at least 120 seconds where configurable, so Chrome's connection prompt has time to be approved.

`npm run install:codex` is a convenience for project-scoped Codex setup in the clone itself. For another project or user scope, merge the launch specification into that actual client's configuration instead. Do not mistake a config written inside the clone for a globally enabled MCP.

Reload/reconnect MCP tools if the client supports it. If a client restart is required, give the user the one necessary restart instruction. Verify discovery of `computer_health` rather than assuming a config edit has loaded the server.

## 4. Verify

Run the isolated end-to-end check:

```sh
npm run test:live
```

This uses a disposable local form, stdio MCP, and live Jev calls. It independently checks saved values and exits nonzero on failure. It requires the TypeSafe key but does not modify an external account.

Then call `computer_health` through the user's connected MCP client. Report the install path, configuration scope, health result, and live test result. If tool discovery needs a restart, say setup is waiting for that restart rather than claiming it is already connected.

## 5. Use it

For browser work in a disposable profile, call `computer_open` with a URL. For the user's existing Chrome on macOS, use:

```json
{
  "kind": "browser",
  "connection": "existing-chrome",
  "url": "https://THE_TASK_SITE"
}
```

The user enables `chrome://inspect/#remote-debugging` and approves Chrome's Allow dialog. Flick creates a task tab in that profile. Keep the session open across related goals to avoid reconnecting for each step; close it when finished. Do not automate Chrome's consent dialog.

Delegate a complete goal to `computer_run` with exact input values and observable `until` conditions. Poll `computer_status`; do not make a host-model call for each click. Use `computer_execute` when Jev should choose among browser/native apps. Use `computer_screenshot` and `computer_continue` when visual interpretation or missing text is needed. Jev performs the subsequent actions.

For native apps, build the helper and have the user grant the launching application Accessibility permission. Screenshots and OCR also need Screen Recording permission. Call `computer_health` to check those permissions.

[Tool contracts, examples, and limitations](docs/reference.md)

## Optional benchmarks

`npm run demo:bench` runs a richer bundled productivity fixture. `npm run demo:record` records it. These are development and demonstration tools, not part of the install or the user's normal workflow.
