# Manos

A CLI [Model Context Protocol](https://modelcontextprotocol.io) server for **ad-hoc UI testing of Android & iOS apps** — purpose-built for the exploratory, test-free loop where an LLM agent pokes at an app and reacts to what it sees.

It controls Android emulators/devices (`adb`) and iOS simulators (`xcrun simctl`, with `idb` for native UI interaction) and exposes 39 tools over stdio.

manos gives an agent a tight **act → observe** loop, **device-condition control**, **crash/log capture**, **network capture** for debug builds, **OCR targeting** for off-tree elements, an **accessibility audit**, and **session recording** that promotes an ad-hoc exploration into a replayable regression test in one call. See [IMPROVEMENTS.md](IMPROVEMENTS.md) for the design rationale and roadmap.

## Install

```bash
npm install -g manos-mcp     # install the CLI, or run on demand with: npx -y manos-mcp
manos doctor             # check toolchain + list devices & capabilities
```

Requires **Node 20+**. Most MCP clients can launch manos on demand with `npx` — no global install needed; see [Register with an MCP client](#register-with-an-mcp-client). Working on manos itself? See [From source](#from-source).

| Backend | Used for | Install |
| --- | --- | --- |
| `adb` | all Android control | Android platform-tools (auto-detected from `$ANDROID_HOME` or the default SDK path) |
| `xcrun simctl` | iOS lifecycle, conditions, logs, screenshots, push | `xcode-select --install` |
| `idb` | fast native iOS UI inspect/tap/type | `brew install idb-companion && pipx install fb-idb` |
| `maestro` | under the hood: `run_flow`, the warm hierarchy engine, and the cross-platform inspect/interaction fallback | <https://maestro.dev> |

iOS UI interaction works **without** `idb` by falling back to Maestro (slower; call `launch_app` first). Android UI inspection falls back from `uiautomator dump` to `maestro hierarchy` automatically when the on-device UiAutomation connection is contended.

## Register with an MCP client

Each tab launches manos with `npx -y manos-mcp serve`, which fetches and runs the published package on demand — no clone or global install required. (If you installed globally with `npm install -g manos-mcp`, use a bare `manos serve` instead.)

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add manos -- npx -y manos-mcp serve
claude mcp list            # verify
```
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Edit `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`) and restart the app:

```json
{
  "mcpServers": {
    "manos": { "command": "npx", "args": ["-y", "manos-mcp", "serve"] }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global), then enable **manos** under Settings → MCP:

```json
{
  "mcpServers": {
    "manos": { "command": "npx", "args": ["-y", "manos-mcp", "serve"] }
  }
}
```
</details>

<details>
<summary><b>VS Code (GitHub Copilot agent mode)</b></summary>

`.vscode/mcp.json` — note the `servers` key and explicit `type`:

```json
{
  "servers": {
    "manos": { "type": "stdio", "command": "npx", "args": ["-y", "manos-mcp", "serve"] }
  }
}
```
</details>

<details>
<summary><b>Windsurf</b></summary>

`~/.codeium/windsurf/mcp_config.json`, then hit **Refresh** in the Windsurf MCP panel:

```json
{
  "mcpServers": {
    "manos": { "command": "npx", "args": ["-y", "manos-mcp", "serve"] }
  }
}
```
</details>

<details>
<summary><b>Other / generic MCP client</b></summary>

Any MCP-capable client speaks the same stdio protocol. Configure a server that runs:

```
command: npx
args:    ["-y", "manos-mcp", "serve"]
transport: stdio
```
</details>

## From source

For working on manos itself, or to pin a local build instead of the published package:

```bash
git clone https://github.com/ryanperkins/Manos-MCP.git && cd Manos-MCP
npm install            # also builds via the prepare script
npm run build          # or rebuild after changes
node dist/cli.js doctor
```

Register the local build by pointing your client's `command`/`args` at `node /ABS/PATH/to/Manos-MCP/dist/cli.js serve` instead of the `npx` form above.

## CLI

```
manos serve      Start the MCP server on stdio (default)
manos doctor     Toolchain + connected devices + per-device capabilities
manos devices    List connected devices (tab-separated)
manos --help
```

## The tools

Full reference and the **Android vs iOS comparison matrix** are in [docs/index.html](docs/index.html). Highlights:

- **Core:** `list_devices`, `device_capabilities`, `inspect_screen`, `take_screenshot`.
- **Authored flows:** `run_flow` runs a declarative flow locally; `cheat_sheet` gives the syntax. `export_flow` (below) turns a recorded session into one.
- **Act + observe:** `tap`, `long_press`, `input_text`, `press_key`, `swipe` — each takes a selector (`id`/`text`/`resource_id`/`accessibility`) **or** coordinates and returns the resulting screen (`observe: screen | diff | screenshot | none`).
- **Smart waits / assertions / search:** `wait_for`, `assert`, `find_elements`, and `find_text` (OCR the screenshot to locate text the accessibility tree misses — styled buttons, canvas/Flutter/game UIs, WebViews). Targeting falls back to OCR automatically when a text selector finds nothing in the tree, or force it with `tap{text, ocr:true}`.
- **App state:** `launch_app`, `stop_app`, `clear_app_state`, `open_deeplink`, `set_permission`.
- **Device conditions:** `set_appearance`, `set_orientation`, `set_locale`, `set_network`, `set_location`, `set_font_scale`, `set_status_bar`, `push_notification`, and `set_conditions` (apply many at once / named presets like `offline`, `accessibility`, `screenshot`).
- **Diagnostics:** `get_logs` (with crash/ANR detection), `a11y_audit`.
- **Network capture (debug apps):** `network_start`/`network_requests`/`network_clear`/`network_stop` — capture decrypted HTTP filtered to specific endpoints. Android hooks OkHttp via Frida (works through HTTP/2, pinning, proxy-bypass); iOS Simulator uses mitmproxy + a `simctl`-trusted CA. See [NETWORK.md](NETWORK.md).
- **Network mocking (Android):** `network_mock` — manipulate live API responses to test hard-to-reproduce states: override `status`/`headers`, replace the `body`, **regex-`rewrite` a field in the live body** (keep the rest), or inject latency. Rule-based (URL regex + method), hot-reloads, no separate mock server or build change. Rides the Frida/OkHttp capture hook (per-process, no host-proxy disruption — `network_start` first). iOS response mocking is in development. See [NETWORK.md](NETWORK.md#mocking-responses-android--network_mock).
- **Recording:** `start_recording` → act → `export_flow` (replayable Maestro flow) or `export_report` (self-contained HTML report: screenshot timeline + flow + logs + captured network).

A typical loop:

```
list_devices → inspect_screen → tap{text:"Login", observe:"diff"} → input_text{...} → wait_for{text:"Welcome"}
```

## How element targeting works

`inspect_screen` returns a compact tree where every node has a **stable `id`** derived from its semantic identity (resource-id / accessibility / class + digit-normalized text), not its position. So a counter ticking from `5` to `6` keeps its id and shows up as a *changed* node in a diff, while a newly-appeared element is *added*. Act tools accept that `id`, a text/resource-id selector, or raw coordinates; when you use a selector, the recorded flow stores the selector (resilient replay) rather than brittle coordinates.

## Performance

Hierarchy reads use a three-tier backend, chosen per device:

1. **adb `uiautomator dump`** (~2.5s, no extra process) — the default on Android. Tried first.
2. **Warm hierarchy engine** — when uiautomator can't reach UI-idle (e.g. apps with constant animations/watermarks, where `uiautomator dump` errors with `could not get idle state`), manos keeps **one long-lived `maestro mcp` child** resident (used under the hood) and reuses its connected driver. First call pays a one-time warm-up; subsequent inspects are **~150–300ms** — the payoff of reusing a resident engine instead of cold-starting the JVM per call.
3. **Cold `maestro hierarchy` CLI** — last resort if the warm session can't start.

Once a device needs the warm session, manos remembers it (per-device) so it doesn't re-pay the uiautomator timeout on every inspect. Screen size/density are cached. The warm child (and its `simulator-server`) are killed via a process-tree cleanup on exit.

Measured on a hard case (an app that never idles, so everything routes through the warm session):

| | First inspect (one-time) | Steady-state inspect (median) | Full tap+observe loop |
| --- | --- | --- | --- |
| **manos** | ~11s | **~175ms** | **~3s** (was ~35s with cold per-call CLI) |

So: on apps where uiautomator works, the adb path is fast with no extra process; on apps that force the fallback, the resident warm engine keeps steady-state inspect in the **~175ms** range, and the act+observe loop avoids the per-action JVM cold-start that made it slow before. The remaining first-call cost is the one-time uiautomator probe before switching to warm.

## Architecture

```
src/
  cli.ts                 serve / doctor / devices
  server.ts              McpServer wiring (stdio)
  tools/
    register.ts          all 39 tools
    context.ts           shared state: resolveTarget + act/observe + last-screen cache
  drivers/
    types.ts             Driver contract + Capability model
    android.ts           adb
    ios.ts               simctl + idb (+ maestro fallback)
    registry.ts          device → driver routing
  core/
    hierarchy.ts         compact JSON, stable ids, screen diff, search
    a11y.ts              accessibility heuristics
    waits.ts             condition polling
    session.ts           action journal
    flow.ts              Maestro-flow emitter
    maestro.ts           maestro CLI passthrough (run_flow, cheat sheet)
    maestroDriver.ts     cold maestro hierarchy + one-shot action fallbacks
    maestroSession.ts    warm long-lived `maestro mcp` backend (fast hierarchy/actions)
    netcapture.ts        network capture (Frida OkHttp / mitmproxy) — see NETWORK.md
    ocr.ts               OCR fallback (Apple Vision / Tesseract) for off-tree elements
  assets/frida/          okhttp-capture.js + sidecar.py (injected by netcapture)
  util/                  exec + toolchain discovery
```

Each driver method may throw a `CapabilityError`; tools surface it as an actionable message instead of an opaque subprocess failure. The capability model is reported live so an agent can check support before relying on a platform-specific action.

## Test

```bash
npm test    # unit tests for hierarchy/diff/a11y/flow (no device needed)
```

The hierarchy parsing, stable-id diffing, accessibility math, screenshot capture, log/crash scan, and the recording→`export_flow`→`maestro check-syntax` pipeline have also been verified end-to-end against a live Android emulator.

## License

MIT
