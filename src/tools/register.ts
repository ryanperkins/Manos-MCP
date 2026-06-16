import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppContext, errMessage, type ContentBlock, type ObserveMode } from "./context.js";
import { findElements, toCompactJson } from "../core/hierarchy.js";
import { auditScreen } from "../core/a11y.js";
import { poll } from "../core/waits.js";
import { cheatSheet, maestroAvailable, runFlow } from "../core/maestro.js";
import { netCapture } from "../core/netcapture.js";
import { applyConditions, PRESETS, resolveConditions } from "../core/conditions.js";
import type { MaestroCommand, Selector } from "../core/flow.js";
import type { Capability } from "../drivers/types.js";

type ToolReturn = { content: ContentBlock[]; isError?: boolean };

interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
  annotations?: Record<string, unknown>;
}

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}
function json(value: unknown): ContentBlock {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

const deviceId = z
  .string()
  .describe("Device id from list_devices (adb serial like 'emulator-5554', or an iOS simulator UDID)");

const observeArg = z
  .enum(["none", "screen", "diff", "screenshot"])
  .default("screen")
  .describe(
    "What to return after the action: 'screen' = fresh compact hierarchy, 'diff' = only what changed since last inspect, 'screenshot' = PNG, 'none' = just confirm.",
  );

const targetShape = {
  x: z.number().optional().describe("Absolute x coordinate (alternative to a selector)"),
  y: z.number().optional().describe("Absolute y coordinate (alternative to a selector)"),
  id: z.string().optional().describe("Stable element id from inspect_screen"),
  text: z.string().optional().describe("Match by visible text (case-insensitive substring)"),
  resource_id: z.string().optional().describe("Match by resource-id (Android) / identifier (iOS)"),
  accessibility: z.string().optional().describe("Match by accessibility label / content-desc"),
  index: z.number().int().optional().describe("Pick the Nth match (0-based) when several match"),
  ocr: z
    .boolean()
    .optional()
    .describe("Force OCR: locate `text` visually in the screenshot instead of the a11y tree (for off-tree / canvas / WebView elements). OCR is also used automatically when a text selector finds nothing in the tree."),
};

const selectorShape = {
  id: z.string().optional(),
  text: z.string().optional(),
  resource_id: z.string().optional(),
  accessibility: z.string().optional(),
  index: z.number().int().optional(),
};

function toFindQuery(a: {
  id?: string;
  text?: string;
  resource_id?: string;
  accessibility?: string;
}) {
  return { id: a.id, text: a.text, resourceId: a.resource_id, accessibility: a.accessibility };
}

function describeSelector(a: {
  id?: string;
  text?: string;
  resource_id?: string;
  accessibility?: string;
}): string {
  return a.text ?? a.accessibility ?? a.resource_id ?? a.id ?? "(any)";
}

function recordSelector(a: {
  id?: string;
  text?: string;
  resource_id?: string;
  accessibility?: string;
  index?: number;
}): Selector {
  const s: Selector = {};
  if (a.resource_id) s.id = a.resource_id;
  else if (a.text) s.text = a.text;
  else if (a.accessibility) s.text = a.accessibility;
  if (a.index !== undefined) s.index = a.index;
  return s;
}

export function registerTools(server: McpServer, ctx: AppContext): void {
  /** Wrap a handler so thrown errors become a clean tool error result. */
  const define = (
    name: string,
    config: ToolConfig,
    handler: (args: any) => Promise<ToolReturn>,
  ) => {
    server.registerTool(name, config as any, (async (args: any) => {
      try {
        return await handler(args ?? {});
      } catch (err) {
        return { content: [text(`Error: ${errMessage(err)}`)], isError: true };
      }
    }) as any);
  };

  // =========================================================================
  // PARITY TOOLS (Maestro MCP equivalents)
  // =========================================================================

  define(
    "list_devices",
    {
      title: "List devices",
      description:
        "List all available local devices (Android emulators/devices via adb, iOS simulators via simctl). Returns id, platform, name, OS version, and state.",
      inputSchema: {},
    },
    async () => {
      const devices = await ctx.registry.listAllDevices();
      if (devices.length === 0) {
        return {
          content: [
            text(
              "No devices found. Boot an Android emulator / connect a device, or boot an iOS simulator (`xcrun simctl boot <udid>`), then retry.",
            ),
          ],
        };
      }
      return { content: [json(devices)] };
    },
  );

  define(
    "inspect_screen",
    {
      title: "Inspect screen",
      description:
        "Get the current screen's view hierarchy as compact JSON with stable element ids. Use the 'id' field with act tools (tap/input_text/...), or target by text/resource-id. Copy text verbatim — never retype from a screenshot.",
      inputSchema: { device_id: deviceId },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const screen = await driver.inspect(a.device_id);
      ctx.rememberScreen(screen);
      return { content: [json(toCompactJson(screen))] };
    },
  );

  define(
    "take_screenshot",
    {
      title: "Take screenshot",
      description: "Capture a PNG screenshot of the current device screen.",
      inputSchema: { device_id: deviceId },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const png = await driver.screenshot(a.device_id);
      return {
        content: [
          text(`Screenshot captured (${png.length} bytes).`),
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    },
  );

  define(
    "run_flow",
    {
      title: "Run Maestro flow",
      description:
        "Run a Maestro flow (delegates to the maestro CLI). Provide exactly one of: yaml (inline), files (paths), or dir. Optional include_tags/exclude_tags (for dir) and env vars.",
      inputSchema: {
        device_id: deviceId.optional(),
        yaml: z.string().optional().describe("Inline flow YAML"),
        files: z.array(z.string()).optional().describe("Flow file paths"),
        dir: z.string().optional().describe("Directory of flows"),
        include_tags: z.array(z.string()).optional(),
        exclude_tags: z.array(z.string()).optional(),
        env: z.record(z.string()).optional().describe("Flow variables"),
      },
    },
    async (a) => {
      if (!(await maestroAvailable())) {
        return {
          content: [text("maestro CLI not found. Install from https://maestro.dev.")],
          isError: true,
        };
      }
      const res = await runFlow({
        deviceId: a.device_id,
        yaml: a.yaml,
        files: a.files,
        dir: a.dir,
        includeTags: a.include_tags,
        excludeTags: a.exclude_tags,
        env: a.env,
      });
      return {
        content: [text(`${res.success ? "✅ Flow passed" : "❌ Flow failed"} (exit ${res.exitCode})\n\n${res.output}`)],
        isError: !res.success,
      };
    },
  );

  define(
    "cheat_sheet",
    {
      title: "Maestro cheat sheet",
      description: "Return Maestro flow syntax guidance and best practices for writing/exporting flows.",
      inputSchema: {},
    },
    async () => ({ content: [text(cheatSheet())] }),
  );

  // =========================================================================
  // CAPABILITIES
  // =========================================================================

  define(
    "device_capabilities",
    {
      title: "Device capabilities",
      description:
        "Report which actions are supported on a device (full/partial/unavailable) with the backend and any caveats. Check this before relying on a platform-specific action.",
      inputSchema: { device_id: deviceId },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const caps = await driver.capabilities(a.device_id);
      return { content: [json({ platform: driver.platform, capabilities: caps })] };
    },
  );

  // =========================================================================
  // ACT + OBSERVE
  // =========================================================================

  define(
    "tap",
    {
      title: "Tap",
      description:
        "Tap an element (by id/text/resource_id/accessibility) or absolute coordinates. Returns the resulting screen state (act+observe) so you don't need a separate inspect call.",
      inputSchema: { device_id: deviceId, ...targetShape, observe: observeArg },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const tgt = await ctx.resolveTarget(a.device_id, a);
      await driver.tap(a.device_id, tgt.x, tgt.y);
      const cmd: MaestroCommand = tgt.selector
        ? { tapOn: tgt.selector }
        : { tapOn: { point: `${tgt.x},${tgt.y}` } };
      ctx.recorder.record(`Tapped ${tgt.label}`, cmd);
      const note = tgt.matchCount > 1 ? ` (${tgt.matchCount} matched; used index ${a.index ?? 0})` : "";
      return { content: await ctx.observe(a.device_id, a.observe, `Tapped ${tgt.label}${note}.`) };
    },
  );

  define(
    "long_press",
    {
      title: "Long press",
      description: "Long-press an element or coordinates for a duration (ms).",
      inputSchema: {
        device_id: deviceId,
        ...targetShape,
        duration_ms: z.number().int().default(1000),
        observe: observeArg,
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const tgt = await ctx.resolveTarget(a.device_id, a);
      await driver.longPress(a.device_id, tgt.x, tgt.y, a.duration_ms);
      ctx.recorder.record(
        `Long-pressed ${tgt.label}`,
        tgt.selector ? { longPressOn: tgt.selector } : { longPressOn: { point: `${tgt.x},${tgt.y}` } },
      );
      return { content: await ctx.observe(a.device_id, a.observe, `Long-pressed ${tgt.label}.`) };
    },
  );

  define(
    "input_text",
    {
      title: "Input text",
      description:
        "Type text into the focused field. Optionally target a field first (id/text/resource_id) to tap it before typing.",
      inputSchema: {
        device_id: deviceId,
        text: z.string().describe("Text to type"),
        id: z.string().optional().describe("Optionally focus this field first"),
        resource_id: z.string().optional(),
        accessibility: z.string().optional(),
        index: z.number().int().optional(),
        per_char_delay_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Per-character typing delay in ms (default 60). Raise it if a field with live formatting (e.g. a credit-card input) drops or reorders characters; set 0 to commit the whole string at once.",
          ),
        observe: observeArg,
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      if (a.id || a.resource_id || a.accessibility) {
        const tgt = await ctx.resolveTarget(a.device_id, {
          id: a.id,
          resource_id: a.resource_id,
          accessibility: a.accessibility,
          index: a.index,
        });
        await driver.tap(a.device_id, tgt.x, tgt.y);
        ctx.recorder.record(
          `Focused ${tgt.label}`,
          tgt.selector ? { tapOn: tgt.selector } : { tapOn: { point: `${tgt.x},${tgt.y}` } },
        );
      }
      await driver.inputText(a.device_id, a.text, { perCharDelayMs: a.per_char_delay_ms });
      ctx.recorder.record(`Typed "${a.text}"`, { inputText: a.text });
      return { content: await ctx.observe(a.device_id, a.observe, `Typed "${a.text}".`) };
    },
  );

  define(
    "press_key",
    {
      title: "Press key",
      description:
        "Press a hardware/system key. Android: back, home, enter, tab, delete, search, menu, volume_up, volume_down, app_switch, power. iOS: enter, delete, tab, space, escape, home, lock, siri.",
      inputSchema: {
        device_id: deviceId,
        key: z.string().describe("Key name (e.g. 'back', 'enter', 'home')"),
        observe: observeArg,
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.pressKey(a.device_id, a.key);
      const k = a.key.toLowerCase();
      const cmd: MaestroCommand =
        k === "back" ? { back: null } : { pressKey: a.key.charAt(0).toUpperCase() + a.key.slice(1) };
      ctx.recorder.record(`Pressed ${a.key}`, cmd);
      return { content: await ctx.observe(a.device_id, a.observe, `Pressed ${a.key}.`) };
    },
  );

  define(
    "swipe",
    {
      title: "Swipe",
      description:
        "Swipe by direction (up/down/left/right) or between two coordinate points. Direction swipes are centered on the screen.",
      inputSchema: {
        device_id: deviceId,
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        x1: z.number().optional(),
        y1: z.number().optional(),
        x2: z.number().optional(),
        y2: z.number().optional(),
        duration_ms: z.number().int().default(300),
        observe: observeArg,
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      let cmd: MaestroCommand;
      let desc: string;
      if (a.direction) {
        const screen = await driver.inspect(a.device_id);
        ctx.rememberScreen(screen);
        const cx = Math.round(screen.width / 2);
        const cy = Math.round(screen.height / 2);
        const dx = Math.round(screen.width * 0.3);
        const dy = Math.round(screen.height * 0.3);
        const map = {
          up: [cx, cy + dy, cx, cy - dy],
          down: [cx, cy - dy, cx, cy + dy],
          left: [cx + dx, cy, cx - dx, cy],
          right: [cx - dx, cy, cx + dx, cy],
        } as const;
        const [sx, sy, ex, ey] = map[a.direction as "up" | "down" | "left" | "right"];
        await driver.swipe(a.device_id, sx, sy, ex, ey, a.duration_ms);
        cmd = { swipe: { direction: a.direction.toUpperCase() } };
        desc = `Swiped ${a.direction}`;
      } else if (
        [a.x1, a.y1, a.x2, a.y2].every((v) => typeof v === "number")
      ) {
        await driver.swipe(a.device_id, a.x1, a.y1, a.x2, a.y2, a.duration_ms);
        cmd = { swipe: { start: `${a.x1},${a.y1}`, end: `${a.x2},${a.y2}` } };
        desc = `Swiped (${a.x1},${a.y1})→(${a.x2},${a.y2})`;
      } else {
        throw new Error("Provide either `direction` or all of x1,y1,x2,y2.");
      }
      ctx.recorder.record(desc, cmd);
      return { content: await ctx.observe(a.device_id, a.observe, `${desc}.`) };
    },
  );

  define(
    "assert",
    {
      title: "Assert",
      description:
        "Assert an element is visible or not visible on the current screen. Returns pass/fail without polling (use wait_for to wait).",
      inputSchema: {
        device_id: deviceId,
        condition: z.enum(["visible", "not_visible"]).default("visible"),
        ...selectorShape,
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const screen = await driver.inspect(a.device_id);
      ctx.rememberScreen(screen);
      const matches = findElements(screen, toFindQuery(a));
      const visible = matches.length > 0;
      const pass = a.condition === "visible" ? visible : !visible;
      const sel = describeSelector(a);
      ctx.recorder.record(
        `Assert ${sel} ${a.condition}`,
        a.condition === "visible"
          ? { assertVisible: recordSelector(a) }
          : { assertNotVisible: recordSelector(a) },
      );
      return {
        content: [
          text(
            `${pass ? "✅ PASS" : "❌ FAIL"} — expected "${sel}" ${a.condition.replace("_", " ")}; found ${matches.length} match(es).`,
          ),
        ],
        isError: !pass,
      };
    },
  );

  define(
    "wait_for",
    {
      title: "Wait for",
      description:
        "Poll the screen until an element becomes visible or not_visible, or timeout. Replaces fixed sleeps — fast when ready, patient when not.",
      inputSchema: {
        device_id: deviceId,
        condition: z.enum(["visible", "not_visible"]).default("visible"),
        ...selectorShape,
        timeout_ms: z.number().int().default(10_000),
        interval_ms: z.number().int().default(500),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const want = a.condition === "visible";
      const result = await poll({
        timeoutMs: a.timeout_ms,
        intervalMs: a.interval_ms,
        attempt: async () => {
          const screen = await driver.inspect(a.device_id);
          ctx.rememberScreen(screen);
          return findElements(screen, toFindQuery(a)).length > 0;
        },
        done: (visible) => visible === want,
      });
      const sel = describeSelector(a);
      ctx.recorder.record(
        `Wait until ${sel} ${a.condition} (timeout ${a.timeout_ms}ms)`,
        {
          extendedWaitUntil: want
            ? { visible: recordSelector(a), timeout: a.timeout_ms }
            : { notVisible: recordSelector(a), timeout: a.timeout_ms },
        },
      );
      return {
        content: [
          text(
            `${result.satisfied ? "✅" : "⏱️ TIMEOUT"} — "${sel}" ${a.condition.replace("_", " ")} after ${result.elapsedMs}ms (${result.attempts} checks).`,
          ),
        ],
        isError: !result.satisfied,
      };
    },
  );

  define(
    "find_elements",
    {
      title: "Find elements",
      description:
        "Search the current screen for elements matching a query. Returns matching elements (id, bounds, text, etc.) — handy to disambiguate before acting.",
      inputSchema: {
        device_id: deviceId,
        ...selectorShape,
        clickable_only: z.boolean().default(false),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const screen = await driver.inspect(a.device_id);
      ctx.rememberScreen(screen);
      const matches = findElements(screen, { ...toFindQuery(a), clickableOnly: a.clickable_only });
      return {
        content: [
          json(
            matches.map((m) => ({
              id: m.id,
              text: m.text,
              resource_id: m.resourceId,
              a11y: m.accessibility,
              bounds: [m.bounds.x, m.bounds.y, m.bounds.width, m.bounds.height],
              clickable: m.clickable,
            })),
          ),
        ],
      };
    },
  );

  define(
    "find_text",
    {
      title: "Find text (OCR)",
      description:
        "OCR the current screenshot and return on-screen text with pixel bounding boxes — finds elements the accessibility tree misses (styled buttons, canvas/Flutter/game UIs, WebViews). Optionally filter by a query. Tap a result with tap{text, ocr:true}.",
      inputSchema: {
        device_id: deviceId,
        query: z.string().optional().describe("Only return text containing this (case-insensitive)"),
        min_confidence: z.number().default(0.3),
      },
    },
    async (a) => {
      const words = await ctx.ocrScreen(a.device_id, a.query);
      const out = words
        .filter((w) => w.confidence >= a.min_confidence)
        .map((w) => ({
          text: w.text,
          bounds: [w.x, w.y, w.width, w.height],
          center: [Math.round(w.x + w.width / 2), Math.round(w.y + w.height / 2)],
          confidence: Number(w.confidence.toFixed(2)),
        }));
      return {
        content: [text(`${out.length} text run(s) found by OCR:\n${JSON.stringify(out, null, 1)}`)],
      };
    },
  );

  // =========================================================================
  // APP LIFECYCLE / STATE
  // =========================================================================

  define(
    "launch_app",
    {
      title: "Launch app",
      description: "Launch an app by bundle id (iOS) / package name (Android). Optionally clear state first.",
      inputSchema: {
        device_id: deviceId,
        app_id: z.string(),
        clear_state: z.boolean().default(false),
        observe: observeArg.default("none"),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      if (a.clear_state) await driver.clearAppState(a.device_id, a.app_id);
      await driver.launchApp(a.device_id, a.app_id);
      ctx.recorder.noteApp(a.app_id);
      ctx.recorder.record(
        `Launched ${a.app_id}${a.clear_state ? " (cleared state)" : ""}`,
        { launchApp: { appId: a.app_id, clearState: a.clear_state || undefined } },
      );
      return { content: await ctx.observe(a.device_id, a.observe, `Launched ${a.app_id}.`) };
    },
  );

  define(
    "stop_app",
    {
      title: "Stop app",
      description: "Force-stop / terminate an app.",
      inputSchema: { device_id: deviceId, app_id: z.string() },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.stopApp(a.device_id, a.app_id);
      ctx.recorder.record(`Stopped ${a.app_id}`, { stopApp: a.app_id });
      return { content: [text(`Stopped ${a.app_id}.`)] };
    },
  );

  define(
    "clear_app_state",
    {
      title: "Clear app state",
      description:
        "Reset app state. Android: full data wipe (pm clear). iOS: resets permissions (full data wipe needs reinstall).",
      inputSchema: { device_id: deviceId, app_id: z.string() },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.clearAppState(a.device_id, a.app_id);
      ctx.recorder.record(`Cleared state for ${a.app_id}`, { clearState: a.app_id });
      const note =
        ctx.registry.platformOf(a.device_id) === "ios"
          ? " (iOS: permissions reset; data wipe requires reinstall)"
          : "";
      return { content: [text(`Cleared state for ${a.app_id}${note}.`)] };
    },
  );

  define(
    "open_deeplink",
    {
      title: "Open deep link",
      description: "Open a deep link / universal link URL on the device.",
      inputSchema: { device_id: deviceId, url: z.string(), observe: observeArg.default("none") },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.openDeeplink(a.device_id, a.url);
      ctx.recorder.record(`Opened deep link ${a.url}`, { openLink: a.url });
      return { content: await ctx.observe(a.device_id, a.observe, `Opened ${a.url}.`) };
    },
  );

  define(
    "set_permission",
    {
      title: "Set permission",
      description:
        "Grant or revoke a runtime permission for an app. Aliases: camera, microphone, location, contacts, photos, notifications, calendar, etc.",
      inputSchema: {
        device_id: deviceId,
        app_id: z.string(),
        permission: z.string(),
        grant: z.boolean().default(true),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.setPermission(a.device_id, a.app_id, a.permission, a.grant);
      return {
        content: [text(`${a.grant ? "Granted" : "Revoked"} ${a.permission} for ${a.app_id}.`)],
      };
    },
  );

  // =========================================================================
  // DEVICE CONDITIONS
  // =========================================================================

  define(
    "set_appearance",
    {
      title: "Set appearance",
      description: "Switch the system appearance between light and dark mode.",
      inputSchema: { device_id: deviceId, appearance: z.enum(["light", "dark"]) },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.setAppearance(a.device_id, a.appearance);
      return { content: [text(`Set appearance to ${a.appearance}.`)] };
    },
  );

  define(
    "set_orientation",
    {
      title: "Set orientation",
      description:
        "Set device orientation (portrait, landscape-left, landscape-right, upside-down). Android only; iOS simulators must be rotated via the Simulator menu.",
      inputSchema: {
        device_id: deviceId,
        orientation: z.enum(["portrait", "landscape-left", "landscape-right", "upside-down"]),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.setOrientation(a.device_id, a.orientation);
      return { content: [text(`Set orientation to ${a.orientation}.`)] };
    },
  );

  define(
    "set_locale",
    {
      title: "Set locale",
      description:
        "Set app locale (BCP-47, e.g. 'fr-FR'). Android: per-app, requires API 33+. iOS: applied by relaunching the app. Provide app_id.",
      inputSchema: { device_id: deviceId, locale: z.string(), app_id: z.string().optional() },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.setLocale(a.device_id, a.locale, a.app_id);
      return { content: [text(`Set locale to ${a.locale}.`)] };
    },
  );

  define(
    "set_network",
    {
      title: "Set network condition",
      description:
        "Toggle wifi/cellular/airplane mode. Android only (emulator/device); iOS simulators share the host network (use Network Link Conditioner).",
      inputSchema: {
        device_id: deviceId,
        wifi: z.boolean().optional(),
        cellular: z.boolean().optional(),
        airplane_mode: z.boolean().optional(),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.setNetwork(a.device_id, {
        wifi: a.wifi,
        cellular: a.cellular,
        airplaneMode: a.airplane_mode,
      });
      return { content: [text(`Updated network condition.`)] };
    },
  );

  define(
    "set_location",
    {
      title: "Set GPS location",
      description: "Set the simulated GPS location. Android: emulator only. iOS: any simulator.",
      inputSchema: { device_id: deviceId, latitude: z.number(), longitude: z.number() },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.setLocation(a.device_id, a.latitude, a.longitude);
      ctx.recorder.record(`Set location to ${a.latitude},${a.longitude}`, {
        setLocation: { latitude: a.latitude, longitude: a.longitude },
      });
      return { content: [text(`Set location to ${a.latitude}, ${a.longitude}.`)] };
    },
  );

  define(
    "set_font_scale",
    {
      title: "Set font scale",
      description:
        "Set text size for accessibility testing. scale 1.0 = default. Android sets font_scale directly; iOS maps to the nearest Dynamic Type size.",
      inputSchema: { device_id: deviceId, scale: z.number().describe("e.g. 0.85, 1.0, 1.3, 2.0") },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.setFontScale(a.device_id, a.scale);
      return { content: [text(`Set font scale to ${a.scale}.`)] };
    },
  );

  define(
    "set_status_bar",
    {
      title: "Override status bar",
      description:
        "Override the status bar (time, battery, signal) for clean screenshots. iOS: rich (simctl). Android: clock/battery/signal via SystemUI demo mode.",
      inputSchema: {
        device_id: deviceId,
        time: z.string().optional().describe("e.g. '9:41'"),
        battery_level: z.number().min(0).max(100).optional(),
        battery_state: z.enum(["charging", "charged", "discharging"]).optional(),
        cellular_bars: z.number().min(0).max(4).optional(),
        wifi_bars: z.number().min(0).max(3).optional(),
        operator_name: z.string().optional(),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.setStatusBar(a.device_id, {
        time: a.time,
        batteryLevel: a.battery_level,
        batteryState: a.battery_state,
        cellularBars: a.cellular_bars,
        wifiBars: a.wifi_bars,
        operatorName: a.operator_name,
      });
      return { content: [text("Status bar overridden.")] };
    },
  );

  define(
    "push_notification",
    {
      title: "Push notification",
      description:
        "Deliver a push notification. iOS: injects an APNs payload via simctl push. Android: unavailable (needs FCM server key + token).",
      inputSchema: {
        device_id: deviceId,
        app_id: z.string(),
        payload: z
          .record(z.any())
          .describe('APNs payload object, e.g. {"aps":{"alert":"Hi"}}'),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      await driver.pushNotification(a.device_id, a.app_id, a.payload);
      return { content: [text(`Delivered push to ${a.app_id}.`)] };
    },
  );

  define(
    "set_conditions",
    {
      title: "Set device conditions (preset)",
      description:
        `Apply multiple device conditions in one call — the edge-case states where bugs hide. Use a named preset and/or explicit fields (explicit overrides the preset). Each condition reports applied/skipped/failed (unsupported ones are skipped with a reason, not a failure). Presets: ${Object.entries(
          PRESETS,
        )
          .map(([k, v]) => `${k} (${v.description})`)
          .join("; ")}.`,
      inputSchema: {
        device_id: deviceId,
        preset: z.enum(["reset", "screenshot", "accessibility", "offline", "dark", "international"]).optional(),
        app_id: z.string().optional().describe("Needed for locale changes"),
        appearance: z.enum(["light", "dark"]).optional(),
        orientation: z.enum(["portrait", "landscape-left", "landscape-right", "upside-down"]).optional(),
        locale: z.string().optional().describe("BCP-47, e.g. fr-FR"),
        font_scale: z.number().optional().describe("1.0 = default"),
        network: z
          .object({
            wifi: z.boolean().optional(),
            cellular: z.boolean().optional(),
            airplane_mode: z.boolean().optional(),
          })
          .optional(),
        location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const explicit = {
        appearance: a.appearance,
        orientation: a.orientation,
        locale: a.locale,
        fontScale: a.font_scale,
        network: a.network
          ? { wifi: a.network.wifi, cellular: a.network.cellular, airplaneMode: a.network.airplane_mode }
          : undefined,
        location: a.location,
      };
      const set = resolveConditions(a.preset, explicit);
      const results = await applyConditions(driver, a.device_id, set, a.app_id);
      const summary = results
        .map((r) => `  ${r.status === "applied" ? "✅" : r.status === "skipped" ? "⏭️" : "❌"} ${r.condition}: ${r.detail ?? r.status}`)
        .join("\n");
      const label = a.preset ? `preset "${a.preset}"` : "conditions";
      return {
        content: [text(`Applied ${label}:\n${summary || "  (nothing to apply)"}`)],
        isError: results.some((r) => r.status === "failed"),
      };
    },
  );

  // =========================================================================
  // DIAGNOSTICS
  // =========================================================================

  define(
    "get_logs",
    {
      title: "Get device logs",
      description:
        "Fetch recent device logs (Android logcat / iOS unified log) with automatic crash & ANR detection. Filter by app_id, substring, time window, and line cap.",
      inputSchema: {
        device_id: deviceId,
        app_id: z.string().optional(),
        filter: z.string().optional(),
        since_seconds: z.number().int().optional(),
        max_lines: z.number().int().default(400),
      },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const res = await driver.getLogs(a.device_id, {
        appId: a.app_id,
        filter: a.filter,
        sinceSeconds: a.since_seconds,
        maxLines: a.max_lines,
      });
      const header =
        res.crashes.length > 0
          ? `⚠️ ${res.crashes.length} crash/ANR signal(s) detected:\n${JSON.stringify(res.crashes, null, 2)}\n\n--- logs (${res.backend}) ---\n`
          : `No crashes detected. --- logs (${res.backend}) ---\n`;
      return { content: [text(header + res.lines.join("\n"))] };
    },
  );

  define(
    "a11y_audit",
    {
      title: "Accessibility audit",
      description:
        "Audit the current screen for accessibility issues: undersized touch targets, unlabeled interactive controls, and duplicate labels. (Color-contrast needs pixels and is not evaluated.)",
      inputSchema: { device_id: deviceId },
    },
    async (a) => {
      const driver = ctx.registry.driverFor(a.device_id);
      const screen = await driver.inspect(a.device_id);
      ctx.rememberScreen(screen);
      const report = auditScreen(screen);
      return { content: [json(report)] };
    },
  );

  // =========================================================================
  // NETWORK CAPTURE
  //   Android: Frida + OkHttp hook (debuggable app, frida-server, root)
  //   iOS sim: mitmproxy + macOS proxy + simctl-trusted CA
  // =========================================================================

  define(
    "network_start",
    {
      title: "Start network capture",
      description:
        "Capture decrypted HTTP, filtered to specific endpoints. Android: hooks OkHttp via Frida in a debuggable app (app_id required; needs frida-server). iOS simulator: routes the sim through mitmproxy with a simctl-trusted CA (app_id optional; temporarily sets the macOS proxy, restored on stop). `filter` is a URL regex (e.g. 'v2/search').",
      inputSchema: {
        device_id: deviceId,
        app_id: z
          .string()
          .optional()
          .describe("Package/bundle id. Required on Android; optional on iOS (proxy is device-wide)."),
        filter: z.string().optional().describe("URL regex; only matching requests are recorded"),
        spawn: z
          .boolean()
          .default(false)
          .describe("Android only: spawn the app fresh to capture startup traffic"),
      },
    },
    async (a) => {
      const platform = ctx.registry.platformOf(a.device_id);
      const res = await netCapture.start(a.device_id, {
        platform,
        appId: a.app_id,
        filter: a.filter,
        spawn: a.spawn,
      });
      return { content: [text(res.message)], isError: !res.started };
    },
  );

  define(
    "network_requests",
    {
      title: "Get captured requests",
      description:
        "Return captured HTTP exchanges (method, url, status). Compact by default; set include_headers/include_body for detail. Filter by URL regex and limit count to avoid flooding.",
      inputSchema: {
        device_id: deviceId,
        filter: z.string().optional().describe("Further filter captured URLs by regex"),
        since_ts: z.number().optional().describe("Only return exchanges after this epoch-seconds timestamp"),
        limit: z.number().int().default(80),
        include_headers: z.boolean().default(false),
        include_body: z.boolean().default(false),
      },
    },
    async (a) => {
      const { exchanges, total, capturing } = await netCapture.requests(a.device_id, {
        filter: a.filter,
        sinceTs: a.since_ts,
        limit: a.limit,
      });
      if (!capturing && exchanges.length === 0) {
        return {
          content: [text("No capture running. Call network_start first.")],
          isError: true,
        };
      }
      const lines = exchanges.map((e) => {
        if (e.error) return `  ✗ error: ${e.error}`;
        const status = e.status !== undefined ? `${e.status}` : "···";
        let line = `${status} ${e.method ?? ""} ${e.url ?? ""}`;
        if (a.include_headers) {
          if (e.reqHeaders) line += `\n    req headers: ${JSON.stringify(e.reqHeaders)}`;
          if (e.respHeaders) line += `\n    res headers: ${JSON.stringify(e.respHeaders)}`;
        }
        if (a.include_body) {
          if (e.reqBody) line += `\n    req body: ${e.reqBody.slice(0, 2000)}`;
          if (e.respBody) line += `\n    res body: ${e.respBody.slice(0, 4000)}`;
        }
        return line;
      });
      const header = `${exchanges.length} endpoint(s) shown of ${total}${capturing ? " (capturing)" : ""}:`;
      return { content: [text(`${header}\n${lines.join("\n")}`)] };
    },
  );

  define(
    "network_clear",
    {
      title: "Clear captured requests",
      description: "Clear the captured-request buffer without stopping the capture.",
      inputSchema: { device_id: deviceId },
    },
    async (a) => {
      await netCapture.clear(a.device_id);
      return { content: [text("Cleared captured requests.")] };
    },
  );

  define(
    "network_stop",
    {
      title: "Stop network capture",
      description: "Stop capturing (detach Frida / stop mitmproxy and restore the macOS proxy).",
      inputSchema: { device_id: deviceId },
    },
    async (a) => {
      const { stopped } = await netCapture.stop(a.device_id);
      return { content: [text(stopped ? "Capture stopped." : "No capture was running.")] };
    },
  );

  // =========================================================================
  // SESSION RECORDING  ->  REPLAYABLE FLOW
  // =========================================================================

  define(
    "start_recording",
    {
      title: "Start recording",
      description:
        "Begin recording subsequent act tools as a session that can be exported to a replayable Maestro flow (export_flow) or an annotated HTML report (export_report). Set report=true to also screenshot after each action for the report.",
      inputSchema: {
        app_id: z.string().optional(),
        report: z
          .boolean()
          .default(false)
          .describe("Capture a screenshot after each action, for export_report"),
      },
    },
    async (a) => {
      ctx.recorder.start(a.app_id, { captureScreenshots: a.report });
      return {
        content: [
          text(
            `Recording started${a.app_id ? ` for ${a.app_id}` : ""}${a.report ? " with screenshots" : ""}. Interact, then export_flow / export_report.`,
          ),
        ],
      };
    },
  );

  define(
    "stop_recording",
    {
      title: "Stop recording",
      description: "Stop recording the current session (keeps recorded steps for export_flow).",
      inputSchema: {},
    },
    async () => {
      ctx.recorder.stop();
      return { content: [text(`Recording stopped. ${ctx.recorder.count()} step(s) captured.`)] };
    },
  );

  define(
    "export_flow",
    {
      title: "Export flow",
      description:
        "Export the recorded session as a replayable Maestro flow (YAML) plus a human-readable report. Run it later with run_flow.",
      inputSchema: {},
    },
    async () => {
      const out = ctx.recorder.exportFlow();
      if (out.stepCount === 0) {
        return {
          content: [text("No steps recorded. Call start_recording, interact, then export_flow.")],
          isError: true,
        };
      }
      return {
        content: [
          text(`Exported ${out.stepCount} step(s) as a Maestro flow.\n\n--- flow.yaml ---\n${out.yaml}\n--- report.md ---\n${out.markdown}`),
        ],
      };
    },
  );

  define(
    "export_report",
    {
      title: "Export session report (HTML)",
      description:
        "Write a self-contained HTML report of the recorded session — a step timeline with screenshots (if report capture was on) plus an appendix with the replayable flow, captured network requests, and recent logs/crashes. Returns the file path. Best with start_recording(report=true).",
      inputSchema: {
        output_path: z.string().optional().describe("Where to write the .html (default: temp dir)"),
        include_logs: z.boolean().default(true),
        include_network: z.boolean().default(true),
      },
    },
    async (a) => {
      if (ctx.recorder.count() === 0) {
        return {
          content: [text("No steps recorded. Call start_recording(report=true), interact, then export_report.")],
          isError: true,
        };
      }
      const dev = ctx.recorder.device;
      let logs: string | undefined;
      let network: string | undefined;
      if (dev) {
        if (a.include_logs) {
          try {
            const r = await ctx.registry.driverFor(dev).getLogs(dev, { maxLines: 120 });
            const crashes = r.crashes.length
              ? `⚠️ ${r.crashes.length} crash/ANR signal(s):\n${JSON.stringify(r.crashes, null, 2)}\n\n`
              : "";
            logs = crashes + r.lines.join("\n");
          } catch {
            /* logs optional */
          }
        }
        if (a.include_network) {
          try {
            const { exchanges } = await netCapture.requests(dev, { limit: 200 });
            if (exchanges.length) {
              network = exchanges
                .map((e) => (e.error ? `✗ ${e.error}` : `${e.status ?? "···"} ${e.method ?? ""} ${e.url ?? ""}`))
                .join("\n");
            }
          } catch {
            /* network optional */
          }
        }
      }
      const out = ctx.recorder.exportReport({ logs, network });
      const path =
        a.output_path ?? join(tmpdir(), `manos-report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
      await writeFile(path, out.html, "utf8");
      return {
        content: [
          text(
            `Wrote session report (${out.stepCount} steps, ${out.withScreenshots} with screenshots) to:\n${path}`,
          ),
        ],
      };
    },
  );
}

// Re-export so the server module can build the capability list without importing types twice.
export type { Capability };
