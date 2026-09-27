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

Merge the generated `flick` entry into your MCP client's configuration. It launches `node /absolute/path/dist/cli.js` and loads `.env.local` from the installation directory. For native macOS support and the optional browser OCR fallback, add `--native` to setup. Native app control needs Accessibility permission; native window capture needs Screen Recording permission. Browser OCR reads the browser tab screenshot locally.

## Use it

1. `computer_open` opens a browser or native session.
2. `computer_run` accepts a goal, exact `inputs`, and observable `until` conditions.
3. `computer_status` waits for a result; `computer_continue` supplies missing information when needed.
4. Keep the session for related goals, then `computer_close`.

`computer_execute` handles goals across an available browser/native target catalog. Screenshot tools let the host agent supply visual interpretation; Jev handles subsequent actions. [Tool schemas, examples, and internals](docs/reference.md)

For your signed-in Chrome on macOS, use `connection: "existing-chrome"`. Enable remote debugging at `chrome://inspect/#remote-debugging`, then approve Chrome's connection prompt. Flick starts in a task tab; Jev can switch among observed tabs in that Chrome profile. Closing the session closes only Flick-created tabs and leaves your other tabs and browser open. The default mode uses a dedicated Playwright profile. [Chrome connection documentation](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)

## Optional local playground

Run `npm run playground` and open the printed `127.0.0.1` URL. The **Talk to Jev** view sends your own state, question, and optional choices directly to TypeSafe through a local server. It shows the exact request, typed answer, probabilities, and timing without controlling your computer. Leave choices empty for a yes/no probability; use the raw JSON field for Score or several questions. Jev is a decision model, so this is a chat-style test bench rather than a text-generating chatbot.

The separate **Computer task** view sends one complete goal to Flick and displays Jev's action log. Its default **Any Mac app** mode discovers installed and running apps, lets Jev choose among them, and can launch an app that is not yet open. You can also restrict the task to one Mac app or use the fast existing-Chrome connection. The writing helper proposes an outcome checklist; Jev directly advances it and declares completion. There is no secondary milestone approval gate. Action errors and observations remain available to Jev. The optional completion field adds an exact visible-text or URL check; leave it empty to use the checklist. The live view shows the checklist, saved-text count, and guides loaded for the current app. The playground binds only to localhost and reads the same local TypeSafe key as the MCP server.

Tasks retain exact generated and observed text across apps, so a poem drafted in Notes can be reused verbatim in a message. The main agent can also supply a plan with observable `doneWhen` conditions. Action checks distinguish a changed screen from an accomplished outcome; recovery decisions receive the missing expected result.

Flick includes concise [app and website guides](app-guides/README.md), loaded only when the observed app, hostname, or controls match. Use `computer_guide_read` to inspect guidance and failure lessons, then `computer_guide_update` to save a versioned local improvement with observed evidence. Failed interactions create suggestions for review; successful recovery evidence is required before those suggestions become active guidance. Local lessons and redacted task traces stay in the configured data directory and are never published automatically.

Optionally set `CEREBRAS_API_KEY`, `GROQ_API_KEY`, or `OPENAI_API_KEY` in `.env.local` to let Jev request text for an observed field and get a recovery hint after repeated action errors. Flick starts with Cerebras, measures successful helper latency, and then prefers the fastest available provider. It switches before a Groq token limit when response headers show too few tokens for another request, and switches immediately on a provider error. OpenAI `gpt-6-luna` uses `reasoning_effort: none`. If all providers are unavailable, a short `Retry-After` is honored. Jev still chooses the field and the next computer action; text helpers are not called for ordinary clicks. Exact supplied values remain available without a text provider.

## Architecture

```text
MCP client ── goal + inputs + completion conditions ──► local runner
                                                          │
                         ┌── observe ◄── DOM / macOS AX ◄──┤
                         │       ╰── optional local OCR ◄──┤
                         │                                │
                         └── Jev typed decision ──► execute + verify
                                   │
                                   └── optional Qwen draft / recovery hint
                                                          │
MCP client ◄──────── result / trace / assistance needed ────┘
```

Jev selects bounded actions against observed controls. Code owns exact values, target identity, execution, task memory, and completion checks. Related judgments share a request. Invalid field/value combinations can be withdrawn and reconsidered without executing an action; traces count these extra calls.

The engine runs locally; inference uses the TypeSafe API and, when configured and selected, Cerebras or Groq. Goals, inputs, selected interface text, and memory are sent to TypeSafe. Qwen receives the user goal, current page, and observed form with Jev's chosen field when drafting, or recent errors and current controls when helping recovery. Jev can call a local Apple Vision OCR scan when page text or controls are missing from the DOM; recognized labels become click targets. Screenshots are available to the host agent, but neither Jev nor Qwen receives image pixels.

## Benchmarks and development

```sh
npm run build
npm test                         # no API key required
npm run demo:bench               # six live trials across three synthetic requests
npm run demo:record              # uncut recording, actual playback speed
```

The optional Dispatch fixture is a local task-and-export workflow with eleven independent saved-state checks. One six-trial batch passed 6/6 at a **6.10 s median** for 13–14 actions, with zero host interventions. It is a synthetic local benchmark application, separate from the MCP. [Results and method](docs/benchmarks.md) · [Recording guide](docs/demo.md) · [Contributing](CONTRIBUTING.md)

Early developer release. Browser DOM control is the primary path; native macOS control is experimental. Existing-profile discovery and local OCR currently target macOS. OCR reads text, not the visual meaning of photos or icon-only controls; complex widgets and native dialogs can still need host assistance. Automatic visual handoff is not implemented. Task traces can contain input values; inspect them before sharing. [Data handling and limitations](docs/reference.md)

## Credits

Original implementation using [TypeSafe Jev](https://docs.typesafe.ai/), [Playwright](https://playwright.dev/), and the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). Research inspiration: [jev-turbo](https://github.com/sightmap/jev-turbo), [jev-ultrafast](https://github.com/browser-use/jev-ultrafast), [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use), and [jev-use](https://github.com/savka777/jev-use). These agents are not runtime dependencies, and their benchmark results are not ours.

[MIT](LICENSE). Independent project; not affiliated with TypeSafe.

### Taking control while Flick runs

On macOS, physical mouse movement, clicks, scrolling, or typing interrupt visible browser and native-app tasks. Flick cancels pending model requests and stops issuing input, keeps the task plan and saved text, and waits for an explicit **Continue**. Continuation takes a fresh observation. A key press/click already dispatched to the OS or browser may finish; interrupted submissions are retained for result checking before another attempt.

The passive native monitor is built by `npm run build:native` and uses macOS Input Monitoring permission for the app running Flick. It reports only the input category, never typed keys or pointer positions. Flick's synthetic input is excluded. Pure headless browser tasks do not monitor the desktop. Software-injected remote/assistive input may not be detected, and macOS secure-input mode can hide keyboard events. If the monitor becomes unavailable, Flick stops with a setup/recovery message.

Run `node scripts/user-activity-smoke.mjs` for passive permission, event-source classification, and lifecycle checks. It does not generate user input.

## Carrying information between apps

For work that carries information between pages or apps, describe what Jev must retain before leaving the source. Put capturing the needed facts in the source milestone, name its produces text artifact, and reference that name in later uses. For example: read pricing and retain plan names, prices, billing intervals and source URL as pricing_notes; then use pricing_notes to write the note or email. Jev chooses whether to copy exact source text to the clipboard or request candidate notes from the writing helper and select one to save. Do not assume visiting a page or marking a milestone complete makes its text available to later writing. Keep the full goal in one call and let Jev choose the actions.

A short plan can be: **read and retain pricing → write a note from the retained pricing → copy the finished note into an email draft**. Keep the requested endpoint explicit (for example, leave the email unsent). Task notes live in the current run and its continuations; they are not permanent app guidance.
