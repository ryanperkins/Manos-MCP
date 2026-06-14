# Design rationale & roadmap

This is the design rationale behind Manos and a roadmap for going further.

Most mobile-test tooling is **flow-first**: you author a declarative flow (typically
YAML), run it, and get pass/fail back. That model is ideal for *authored* regression
tests, but it's coarse for the thing an agent is actually doing — **ad-hoc, test-free
exploration where it pokes at the app and reacts to what it sees.** Every interaction
becomes write-a-script → run → re-inspect, and a fresh engine spins up per run. Manos
is built for that interactive loop instead; the improvements below are organized by the
friction that shows up in it.

Legend: ✅ implemented in this server · ◻ roadmap (priority Pn).

---

## 1. The feedback loop is too coarse → make it act + observe

**Friction.** With a flow, the unit of work is a whole script. To explore, the agent
does `inspect_screen` → reason → write a one-line flow → `run` → `inspect_screen`
again. Every interaction is 2–3 round-trips, and `run` spins up a fresh Maestro
session each time (seconds of JVM/driver startup).

- ✅ **Atomic actions with observe-in-one-trip.** `tap`, `long_press`, `input_text`,
  `press_key`, `swipe` each accept a selector *or* coordinates and take an
  `observe` mode (`screen` | `diff` | `screenshot` | `none`) so the result of the
  action comes back in the same call. No separate inspect needed.
- ✅ **Native action backends.** Android actions go straight through `adb input`
  (sub-second); iOS through `idb` when present. Maestro is only the fallback, not the
  hot path.
- ✅ **Warm session reuse.** When `uiautomator dump` can't read a screen (apps that
  never reach UI-idle), manos keeps **one long-lived `maestro mcp` child** resident
  (used under the hood) instead of cold-starting the JVM per call. Steady-state inspect
  drops from ~9–14s to ~150–300ms, and the full tap+observe loop went from ~35s to
  ~3s on such an app. The choice is cached per device; the child is process-tree-killed
  on exit.
- ◻ **P2 — Idle/animation settling.** Before returning state, wait for the UI to stop
  animating (Android `dumpsys gfxinfo` / no-hierarchy-change debounce) so the agent
  doesn't act on a mid-transition screen.

## 2. The screen dump is verbose and not diffable → stable ids + diffs

**Friction.** `inspect_screen` returns the whole compact tree every time. The agent
burns tokens re-reading a near-identical tree after each action and has to eyeball
what changed.

- ✅ **Stable, content-based element ids.** Each node gets an id hashed from its
  semantic identity (resource-id / accessibility / class + *digit-normalized* text),
  not its position. A counter ticking `5 → 6` keeps its id.
- ✅ **Screen diffs.** `observe: "diff"` (and `diffScreens`) returns only
  added / removed / changed nodes vs. the last inspect — meaningful precisely because
  ids are stable.
- ✅ **Targeted search.** `find_elements` returns just the matching nodes, so the agent
  can disambiguate without the full tree.
- ◻ **P3 — Token-budgeted inspect.** A `max_depth` / "interactive-only" filter on
  `inspect_screen` for very dense screens.

## 3. Waiting and asserting are flow-only → first-class, polling-based

**Friction.** Outside a flow there's no "wait until X" or "assert Y" — the agent
resorts to fixed sleeps (flaky and slow) or re-inspect loops it has to manage itself.

- ✅ **`wait_for`** polls inspect until an element is visible / not-visible or a
  timeout — fast when ready, patient when not. Replaces fixed sleeps.
- ✅ **`assert`** gives a clean pass/fail (`isError`) for visible / not-visible.
- ◻ **P2 — Richer assertions.** text-equals, element-count, enabled/checked/selected
  state, and "wait for network idle / no spinners".

## 4. No app state or device condition control → test the states real users hit

**Friction.** Maestro can `clearState` and `launchApp` inside a flow, but a lot of
real bugs live in *device conditions* the agent can't set: dark mode, large fonts,
a French locale, offline, a specific GPS point, a granted/denied permission, a
specific time on the status bar.

- ✅ **App state:** `launch_app` (with `clear_state`), `stop_app`, `clear_app_state`,
  `open_deeplink`, `set_permission`.
- ✅ **Device conditions:** `set_appearance`, `set_orientation`, `set_locale`,
  `set_network`, `set_location`, `set_font_scale`, `set_status_bar`,
  `push_notification`. Each is capability-gated per platform (see the matrix) and
  reports its backend + caveats rather than failing opaquely.
- ✅ **Condition presets.** `set_conditions` applies multiple device conditions in one
  call (appearance, font scale, orientation, network, location, status bar, locale),
  with named presets (`screenshot`, `accessibility`, `offline`, `dark`, `international`,
  `reset`) that explicit fields override. Each condition reports applied / skipped
  (with the platform reason) / failed.
- ◻ **P2 — Time/clock control** for time-dependent UI; **clipboard get/set**; **test
  data seeding** (push files, prefill `NSUserDefaults` / content providers).
- ◻ **P2 — Process-death / restoration testing.** Background the app, kill the process
  (`adb shell am kill`), relaunch, and assert state restored — a classic Android bug
  class that's invisible to flows.

## 5. When something breaks, the agent is blind → capture logs, crashes, a11y

**Friction.** A flow says "failed at step 4." It doesn't hand you the stack trace, the
ANR, or *why* the screen was wrong.

- ✅ **`get_logs`** pulls logcat / the iOS unified log with filtering and **automatic
  crash & ANR detection** surfaced on every fetch — so a failed tap immediately
  yields the exception that caused it.
- ✅ **`a11y_audit`** grades the current screen for undersized touch targets (against
  per-platform, density-correct minimums), unlabeled interactive controls, and
  duplicate accessibility labels.
- ◻ **P1 — Color-contrast & text-size a11y.** Sample pixels from the screenshot at
  each element's bounds to compute WCAG contrast — the one a11y check that needs
  pixels (honestly out of scope for a hierarchy-only audit today).
- ◻ **P2 — Performance signals.** Cold/warm start time, frame jank
  (`gfxinfo`), memory (`dumpsys meminfo`) captured alongside a session.

## 6. Exploration is throwaway → record it into a regression test

**Friction.** The single biggest gap: you poke around, find a bug, reproduce it… and
then have nothing to hand to CI. The knowledge evaporates.

- ✅ **Session recording → replayable flow.** `start_recording`, act, then
  `export_flow` emits a **valid Maestro flow** (verified with `maestro check-syntax`)
  plus a human-readable Markdown report. Selector-based actions are recorded as
  resilient selectors, not brittle coordinates. This promotes an ad-hoc session into a
  regression test in one call — then `run_flow` replays it.
- ✅ **Annotated timeline report.** `start_recording(report=true)` screenshots after
  each action; `export_report` writes a self-contained HTML timeline (screenshots +
  descriptions + replayable commands) with an appendix bundling the flow YAML, the
  network requests captured during the session, and recent logs/crashes.
- ◻ **P2 — Video capture** of the session (`adb screenrecord` / `simctl io recordVideo`)
  attached to the report — great for bug tickets.

## 7. Coverage gaps that limit what's testable → roadmap

- ✅ **OCR fallback for off-tree elements.** Styled `<div>` buttons, canvas/Flutter/game
  UIs, and poor-a11y WebViews expose little hierarchy. `find_text` OCRs the screenshot
  (Apple Vision on macOS, Tesseract elsewhere) and returns pixel-accurate boxes; targeting
  falls back to OCR automatically when a text selector finds nothing in the tree, or force
  it with `tap{text, ocr:true}`. Cross-checked: OCR centers land within ~6px of the a11y
  center for the same element. (Next: icon/template matching for non-text controls.)
- ◻ **P1 — Visual regression.** Capture/approve baseline screenshots and perceptual-
  diff against them, with status-bar overrides already available for stable captures.
- ✅ **Network interception.** `network_start/requests/clear/stop` capture the
  decrypted HTTP an app makes, filtered to specific endpoints. Android hooks OkHttp
  via Frida (through HTTP/2, pinning, proxy-bypass); iOS Simulator uses mitmproxy +
  a `simctl`-trusted CA + the macOS proxy. See [NETWORK.md](NETWORK.md). (Roadmap:
  response stubbing, Cronet, Frida NSURLSession for pinned iOS apps.)
- ◻ **P2 — Multi-device / matrix runs.** Drive the same session across several OS
  versions or form factors in parallel and diff the outcomes.
- ◻ **P3 — Semantic targeting.** Rank hierarchy elements by an embedding/LLM match to
  a natural-language description, so the agent targets "the checkout button" without
  guessing selectors.

---

## Priority summary (roadmap)

| Priority | Item | Why it matters |
| --- | --- | --- |
| P1 | Condition presets | Edge-case states (offline/dark/large-font/locale) are where bugs hide; make them one call. |
| P1 | Annotated timeline report | Turns a session into a shareable, debuggable artifact. |
| P1 | Color-contrast / text a11y | Completes the accessibility story; needs pixel sampling. |
| ✅ | OCR fallback (done) | Unlocks games, Flutter, Canvas, WebViews with thin a11y trees. |
| P1 | Visual regression | The other half of "did this change break the UI?" |
| P2 | Richer assertions + network-idle waits | Fewer flaky, sleep-based steps. |
| P2 | Process-death / restoration testing | High-value Android bug class invisible to flows. |
| P2 | Performance signals, video capture, network interception | Deeper diagnostics per session. |
| P2 | Time/clipboard/data seeding | Removes manual setup before a scenario. |
| P3 | Token-budgeted inspect, semantic targeting, matrix runs | Scale and ergonomics. |

Everything marked ✅ is implemented and, where a device was available, verified
end-to-end against a live Android emulator.
