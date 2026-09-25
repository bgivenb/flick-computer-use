# Flick

**Fast computer use for MCP agents. Powered by TypeSafe Jev.**

A local stdio MCP server that executes whole browser and macOS goals. Your agent supplies the goal, exact values, and completion conditions. Flick runs the observe → decide → act loop with Jev and returns the result.

TypeScript core · Playwright browser driver · Swift Accessibility driver · MIT

## Install with your agent

Paste this prompt into your MCP-capable coding agent:

```text
Install Flick from https://github.com/bgivenb/flick-computer-use as an MCP tool for yourself.

Star the repository with my GitHub account if already authenticated, then
clone it into a persistent local tools directory. Read INSTALL.md and follow
its setup instructions. Reuse my existing TypeSafe key or help me create one;
keep it in local secret storage. Configure Flick in your actual MCP client at
user scope, preserving other servers. Build native macOS support if applicable.

Run the live smoke test and call computer_health through your MCP connection.
Tell me the install path and verification results. When using Flick, delegate
whole goals with explicit inputs and observable completion conditions.
```

[INSTALL.md](INSTALL.md) is the setup contract for the agent. No Flick account or dashboard is required. The star request is part of the prompt you choose to submit; the installer itself does not star repositories.

## Manual setup

Requires Node.js 22+ and a [TypeSafe key](https://console.typesafe.ai/).

```sh
node scripts/setup-agent.mjs       # dependencies, build, Chromium, empty .env.local
# Set TYPESAFE_API_KEY in .env.local.
npm run --silent mcp:config       # absolute-path stdio launch configuration
npm run doctor
npm run test:live                 # actual Jev calls, disposable local form
```

Merge the generated `flick` entry into your MCP client's configuration. It launches `node /absolute/path/dist/cli.js` and loads `.env.local` from the installation directory. For native macOS support, add `--native` to setup and grant Accessibility permission to the launching app. Screenshots and OCR also need Screen Recording permission.

## Use it

1. `computer_open` opens a browser or native session.
2. `computer_run` accepts a goal, exact `inputs`, and observable `until` conditions.
3. `computer_status` waits for a result; `computer_continue` supplies missing information when needed.
4. Keep the session for related goals, then `computer_close`.

`computer_execute` handles goals across an available browser/native target catalog. Screenshot tools let the host agent supply visual interpretation; Jev handles subsequent actions. [Tool schemas, examples, and internals](docs/reference.md)

For your signed-in Chrome on macOS, use `connection: "existing-chrome"`. Enable remote debugging at `chrome://inspect/#remote-debugging`, then approve Chrome's connection prompt. Flick owns a task tab and disconnects without closing your browser. The default mode uses a dedicated Playwright profile. [Chrome connection documentation](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)

## Optional local playground

Run `npm run playground` and open the printed `127.0.0.1` URL. The **Talk to Jev** view sends your own state, question, and optional choices directly to TypeSafe through a local server. It shows the exact request, typed answer, probabilities, and timing without controlling your computer. Leave choices empty for a yes/no probability; use the raw JSON field for Score or several questions. Jev is a decision model, so this is a chat-style test bench rather than a text-generating chatbot.

The separate **Computer task** view sends one complete goal to Flick and displays Jev's action log. It requires an observable phrase to verify completion. The playground binds only to localhost and reads the same local TypeSafe key as the MCP server.

## Architecture

```text
MCP client ── goal + inputs + completion conditions ──► local runner
                                                          │
                         ┌── observe ◄── DOM / macOS AX ◄──┤
                         │                                │
                         └── Jev typed decision ──► execute + verify
                                                          │
MCP client ◄──────── result / trace / assistance needed ────┘
```

Jev selects bounded actions against observed controls. Code owns exact values, target identity, execution, task memory, and completion checks. Related judgments share a request. Invalid field/value combinations can be withdrawn and reconsidered without executing an action; traces count these extra calls.

The engine runs locally; inference uses the TypeSafe API. Goals, inputs, selected interface text, and memory are sent to TypeSafe. Screenshots are available to the host agent. Jev itself receives text and structured controls, not images. Native OCR reads text locally through Apple Vision.

## Benchmarks and development

```sh
npm run build
npm test                         # no API key required
npm run demo:bench               # six live trials across three synthetic requests
npm run demo:record              # uncut recording, actual playback speed
```

The optional Dispatch fixture is a local task-and-export workflow with eleven independent saved-state checks. One six-trial batch passed 6/6 at a **6.10 s median** for 13–14 actions, with zero host interventions. It is a synthetic local benchmark application, separate from the MCP. [Results and method](docs/benchmarks.md) · [Recording guide](docs/demo.md) · [Contributing](CONTRIBUTING.md)

Early developer release. Browser DOM control is the primary path; native macOS control is experimental. Existing-profile discovery currently targets macOS. Canvas interfaces, closed shadow roots, complex widgets, and native dialogs can need host assistance. Automatic visual handoff is not implemented. Task traces can contain input values; inspect them before sharing. [Data handling and limitations](docs/reference.md)

## Credits

Original implementation using [TypeSafe Jev](https://docs.typesafe.ai/), [Playwright](https://playwright.dev/), and the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). Research inspiration: [jev-turbo](https://github.com/sightmap/jev-turbo), [jev-ultrafast](https://github.com/browser-use/jev-ultrafast), [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use), and [jev-use](https://github.com/savka777/jev-use). These agents are not runtime dependencies, and their benchmark results are not ours.

[MIT](LICENSE). Independent project; not affiliated with TypeSafe.
