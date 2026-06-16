import { XMLParser } from "fast-xml-parser";
import { exec, ExecError } from "../util/exec.js";
import { resolveAdb } from "../util/toolchain.js";
import { finalizeScreen, type RawElement } from "../core/hierarchy.js";
import { sleep } from "../core/waits.js";
import { maestroHierarchy } from "../core/maestroDriver.js";
import { maestroSession } from "../core/maestroSession.js";
import {
  CapabilityError,
  type Appearance,
  type Bounds,
  type CapabilityMap,
  type Device,
  type Driver,
  type LogOptions,
  type LogResult,
  type NetworkCondition,
  type Orientation,
  type Screen,
  type StatusBarOverride,
  type CrashReport,
} from "./types.js";

const KEYEVENTS: Record<string, number> = {
  back: 4,
  home: 3,
  enter: 66,
  tab: 61,
  delete: 67,
  backspace: 67,
  search: 84,
  menu: 82,
  power: 26,
  lock: 26,
  volume_up: 24,
  volume_down: 25,
  app_switch: 187,
};

const PERMISSION_ALIASES: Record<string, string> = {
  camera: "android.permission.CAMERA",
  microphone: "android.permission.RECORD_AUDIO",
  location: "android.permission.ACCESS_FINE_LOCATION",
  coarse_location: "android.permission.ACCESS_COARSE_LOCATION",
  contacts: "android.permission.READ_CONTACTS",
  storage: "android.permission.READ_EXTERNAL_STORAGE",
  notifications: "android.permission.POST_NOTIFICATIONS",
  calendar: "android.permission.READ_CALENDAR",
  phone: "android.permission.READ_PHONE_STATE",
};

const ORIENTATION_ROTATION: Record<Orientation, number> = {
  portrait: 0,
  "landscape-left": 1,
  "upside-down": 2,
  "landscape-right": 3,
};

/**
 * Launcher activities that debug builds add as extra home-screen icons but that
 * are never the app's real entry point. Skipped when resolving what to launch.
 */
const DEBUG_LAUNCHER_RE = /leakcanary|\.LeakLauncherActivity$/i;

/** Escape arbitrary text for `adb shell input text`. */
function escapeInputText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "%s")
    .replace(/(["'`$&;|*<>()!~#])/g, "\\$1");
}

/** Backslash-escape shell metacharacters for a single device-shell argument. */
function escapeShellArg(arg: string): string {
  return arg.replace(/(["'`$&;|*<>() \t!~#?])/g, "\\$1");
}

function parseBounds(raw: string): Bounds | null {
  // "[x1,y1][x2,y2]"
  const m = raw.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  private readonly adbPath = resolveAdb();
  private readonly xml = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name) => name === "node",
  });
  /**
   * Per-device hierarchy backend. Once `uiautomator dump` fails on a device
   * (e.g. an app that never reaches UI-idle), we switch to the warm Maestro
   * session permanently for that device — otherwise every inspect would re-pay
   * uiautomator's ~10s idle-wait timeout before failing.
   */
  private readonly hierarchyMode = new Map<string, "adb" | "warm">();
  /** Cached screen size + density per device (avoids 2 adb round-trips per inspect). */
  private readonly metrics = new Map<string, { width: number; height: number; densityDpi?: number }>();

  private adb(serial: string | null, args: string[], opts?: { timeoutMs?: number }) {
    const full = serial ? ["-s", serial, ...args] : args;
    return exec(this.adbPath, full, { timeoutMs: opts?.timeoutMs ?? 20_000 });
  }

  private shell(serial: string, command: string[], opts?: { timeoutMs?: number }) {
    return this.adb(serial, ["shell", ...command], opts);
  }

  async listDevices(): Promise<Device[]> {
    let out: string;
    try {
      out = (await this.adb(null, ["devices", "-l"])).stdout;
    } catch {
      return [];
    }
    const devices: Device[] = [];
    for (const line of out.split("\n").slice(1)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("*")) continue;
      const [serial, state] = trimmed.split(/\s+/);
      if (!serial || state !== "device") continue;
      const isEmulator = serial.startsWith("emulator-");
      let name = serial;
      let osVersion: string | undefined;
      try {
        const model = (await this.shell(serial, ["getprop", "ro.product.model"])).stdout.trim();
        osVersion = (
          await this.shell(serial, ["getprop", "ro.build.version.release"])
        ).stdout.trim();
        if (model) name = isEmulator ? `${model} (emulator)` : model;
      } catch {
        /* device may be unauthorized */
      }
      devices.push({
        id: serial,
        name,
        platform: "android",
        type: isEmulator ? "emulator" : "physical",
        osVersion,
        state: "booted",
      });
    }
    return devices;
  }

  async capabilities(deviceId: string): Promise<CapabilityMap> {
    const isEmulator = deviceId.startsWith("emulator-");
    return {
      inspect: { level: "full", backend: "uiautomator dump → warm maestro session → maestro hierarchy" },
      screenshot: { level: "full", backend: "screencap -p" },
      tap: { level: "full", backend: "input tap" },
      input_text: { level: "full", backend: "input text" },
      swipe: { level: "full", backend: "input swipe" },
      press_key: { level: "full", backend: "input keyevent" },
      launch: { level: "full", backend: "am start (resolved launcher)" },
      stop: { level: "full", backend: "am force-stop" },
      clear_state: { level: "full", backend: "pm clear (true data wipe)" },
      deeplink: { level: "full", backend: "am start -a VIEW -d" },
      permissions: { level: "full", backend: "pm grant/revoke" },
      appearance: { level: "full", backend: "cmd uimode night" },
      orientation: { level: "full", backend: "settings user_rotation" },
      locale: {
        level: "partial",
        backend: "cmd locale set-app-locales",
        note: "Per-app locale requires Android 13+ (API 33) and an appId. System-wide locale needs root.",
      },
      network: { level: "full", backend: "svc wifi/data, cmd connectivity airplane-mode" },
      location: isEmulator
        ? { level: "full", backend: "emu geo fix" }
        : {
            level: "unavailable",
            note: "Physical devices require a mock-location app; only emulators support `emu geo fix`.",
          },
      font_scale: { level: "full", backend: "settings system font_scale" },
      status_bar: {
        level: "partial",
        backend: "SystemUI demo mode",
        note: "Overrides clock/battery/signal via demo mode for clean screenshots; fewer fields than iOS.",
      },
      push: {
        level: "unavailable",
        note: "Android has no simulator-side push injection; FCM delivery needs a server key + device token.",
      },
      logs: { level: "full", backend: "logcat" },
    };
  }

  // --- Observe ---

  async inspect(deviceId: string): Promise<Screen> {
    const { width, height, densityDpi } = await this.screenMetrics(deviceId);

    // Fast path: adb uiautomator dump (~2.5s, no extra process), unless we've
    // already learned this device needs the warm Maestro session.
    let raw: RawElement[] | null = null;
    if (this.hierarchyMode.get(deviceId) !== "warm") {
      try {
        raw = await this.dumpViaUiautomator(deviceId);
        this.hierarchyMode.set(deviceId, "adb");
      } catch {
        this.hierarchyMode.set(deviceId, "warm");
      }
    }

    // Fallback: warm `maestro mcp` session (fast after first call), then the
    // cold `maestro hierarchy` CLI as a last resort.
    if (!raw) {
      const warm = await maestroSession.inspect(deviceId);
      if (warm) raw = warm.raw;
      else raw = (await maestroHierarchy(deviceId)).raw;
    }

    return finalizeScreen(raw, { platform: "android", deviceId, width, height, densityDpi });
  }

  private async screenMetrics(
    deviceId: string,
  ): Promise<{ width: number; height: number; densityDpi?: number }> {
    const cached = this.metrics.get(deviceId);
    if (cached) return cached;
    const [size, densityDpi] = await Promise.all([
      this.queryScreenSize(deviceId),
      this.screenDensity(deviceId),
    ]);
    const m = { ...size, densityDpi };
    this.metrics.set(deviceId, m);
    return m;
  }

  private async dumpViaUiautomator(deviceId: string): Promise<RawElement[]> {
    const xml = await this.dumpHierarchy(deviceId);
    const parsed = this.xml.parse(xml);
    const rootNodes: unknown[] = parsed.hierarchy?.node ?? [];
    return rootNodes.map((n) => this.nodeToRaw(n)).filter((n): n is RawElement => n !== null);
  }

  private async screenDensity(deviceId: string): Promise<number | undefined> {
    try {
      const out = (await this.shell(deviceId, ["wm", "density"])).stdout;
      const matches = [...out.matchAll(/density:\s*(\d+)/gi)];
      const last = matches[matches.length - 1];
      return last ? Number(last[1]) : undefined;
    } catch {
      return undefined;
    }
  }

  private async dumpHierarchy(deviceId: string): Promise<string> {
    const path = "/sdcard/window_dump.xml";
    // Remove any stale dump first. uiautomator can print
    // "ERROR: could not get idle state" (e.g. an app that never settles) and
    // still exit 0 WITHOUT overwriting the file — reading it would silently
    // return a previous screen's hierarchy. Deleting + verifying freshness
    // means a failed dump throws and the caller falls back to maestro.
    await this.shell(deviceId, ["rm", "-f", path]).catch(() => {});
    // Short timeout: on an app that never idles, uiautomator blocks on its
    // idle-wait; we'd rather fail fast and switch to the warm Maestro session.
    // An idle screen dumps in ~2.5s, so 4.5s catches it and bails fast otherwise.
    const res = await this.shell(deviceId, ["uiautomator", "dump", path], { timeoutMs: 4_500 });
    const log = `${res.stdout}\n${res.stderr}`;
    if (/error|could not get idle/i.test(log) || !/dumped to/i.test(log)) {
      throw new Error(
        `uiautomator dump produced no fresh hierarchy: ${log.trim() || "(no output)"}`,
      );
    }
    const out = (await this.shell(deviceId, ["cat", path])).stdout;
    const start = out.indexOf("<");
    if (start < 0 || !out.includes("<hierarchy")) {
      throw new Error("uiautomator dump file missing or unreadable");
    }
    return out.slice(start);
  }

  private nodeToRaw(node: any): RawElement | null {
    const bounds = parseBounds(node.bounds ?? "");
    if (!bounds) return null;
    // Skip zero-area nodes that aren't containers.
    const children = (node.node ?? [])
      .map((c: unknown) => this.nodeToRaw(c))
      .filter((c: RawElement | null): c is RawElement => c !== null);
    if ((bounds.width <= 0 || bounds.height <= 0) && children.length === 0) return null;

    const text = (node.text ?? "").trim() || undefined;
    const desc = (node["content-desc"] ?? "").trim() || undefined;
    return {
      cls: node.class || undefined,
      text,
      resourceId: node["resource-id"] || undefined,
      accessibility: desc,
      bounds,
      clickable: node.clickable === "true",
      enabled: node.enabled !== "false",
      focused: node.focused === "true",
      selected: node.selected === "true",
      checked: node.checked === "true",
      scrollable: node.scrollable === "true",
      children,
    };
  }

  /** Public: screen size in tap space (Android taps & the hierarchy are in pixels). */
  async screenSize(deviceId: string): Promise<{ width: number; height: number }> {
    const { width, height } = await this.screenMetrics(deviceId);
    return { width, height };
  }

  private async queryScreenSize(deviceId: string): Promise<{ width: number; height: number }> {
    const out = (await this.shell(deviceId, ["wm", "size"])).stdout;
    // Prefer "Override size:" if present, else "Physical size:".
    const matches = [...out.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
    const last = matches[matches.length - 1];
    if (last) return { width: Number(last[1]), height: Number(last[2]) };
    return { width: 0, height: 0 };
  }

  async screenshot(deviceId: string): Promise<Buffer> {
    const res = await this.adb(deviceId, ["exec-out", "screencap", "-p"], { timeoutMs: 20_000 });
    return res.stdoutBuffer;
  }

  // --- Act ---

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    await this.shell(deviceId, ["input", "tap", String(x), String(y)]);
  }

  async longPress(deviceId: string, x: number, y: number, durationMs: number): Promise<void> {
    await this.shell(deviceId, [
      "input",
      "swipe",
      String(x),
      String(y),
      String(x),
      String(y),
      String(durationMs),
    ]);
  }

  async inputText(deviceId: string, text: string, opts?: { perCharDelayMs?: number }): Promise<void> {
    if (!text) return;
    // Committing the whole string in one `input text` races fields that reformat
    // on every keystroke (e.g. credit-card inputs whose TextWatcher inserts spaces):
    // characters get dropped or reordered ("4242424242424242" -> "4224 4442"). Type
    // one character at a time with a small settle delay so each keystroke is fully
    // processed before the next. Single chars keep the original fast path.
    const chars = [...text];
    if (chars.length <= 1) {
      await this.shell(deviceId, ["input", "text", escapeInputText(text)]);
      return;
    }
    const delay = Math.max(0, opts?.perCharDelayMs ?? 60);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      // A bare space is swallowed by `input text`; send it as a key event instead.
      if (ch === " ") {
        await this.shell(deviceId, ["input", "keyevent", "62"]); // KEYCODE_SPACE
      } else {
        await this.shell(deviceId, ["input", "text", escapeInputText(ch)]);
      }
      if (delay > 0 && i < chars.length - 1) await sleep(delay);
    }
  }

  async swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<void> {
    await this.shell(deviceId, [
      "input",
      "swipe",
      String(x1),
      String(y1),
      String(x2),
      String(y2),
      String(durationMs),
    ]);
  }

  async pressKey(deviceId: string, key: string): Promise<void> {
    const code = KEYEVENTS[key.toLowerCase()];
    if (code === undefined) {
      throw new Error(`Unknown key "${key}". Known: ${Object.keys(KEYEVENTS).join(", ")}`);
    }
    await this.shell(deviceId, ["input", "keyevent", String(code)]);
  }

  // --- App lifecycle / state ---

  async launchApp(deviceId: string, appId: string, _args?: string[]): Promise<void> {
    // Explicit component ("pkg/activity") — launch it directly.
    if (appId.includes("/")) {
      await this.shell(deviceId, ["am", "start", "-n", appId]);
      return;
    }
    // Resolve the app's own MAIN/LAUNCHER activity so launches are deterministic.
    // Debug builds often register extra launcher icons (e.g. LeakCanary), and a
    // bare `monkey -c LAUNCHER` picks among them at random — landing on the wrong
    // activity ~half the time. Pick the app's real launcher and start it explicitly.
    const component = await this.resolveLauncherComponent(deviceId, appId);
    if (component) {
      await this.shell(deviceId, ["am", "start", "-n", component]);
      return;
    }
    // Fallback: best-effort launcher intent (older devices without query-activities).
    await this.shell(deviceId, [
      "monkey",
      "-p",
      appId,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
  }

  /**
   * Find the app's real MAIN/LAUNCHER activity, deterministically. When a package
   * declares more than one launcher (common in debug builds — LeakCanary, dev
   * tools), prefer the one that isn't a known debug-only launcher.
   */
  private async resolveLauncherComponent(deviceId: string, appId: string): Promise<string | null> {
    let out: string;
    try {
      out = (
        await this.shell(deviceId, [
          "cmd",
          "package",
          "query-activities",
          "--brief",
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.LAUNCHER",
        ])
      ).stdout;
    } catch {
      return null; // query-activities unavailable → caller falls back to monkey
    }
    const comps = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith(`${appId}/`));
    if (comps.length === 0) return null;
    return comps.find((c) => !DEBUG_LAUNCHER_RE.test(c)) ?? comps[0]!;
  }

  async stopApp(deviceId: string, appId: string): Promise<void> {
    await this.shell(deviceId, ["am", "force-stop", appId]);
  }

  async clearAppState(deviceId: string, appId: string): Promise<void> {
    await this.shell(deviceId, ["pm", "clear", appId]);
  }

  async openDeeplink(deviceId: string, url: string): Promise<void> {
    await this.shell(deviceId, [
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      escapeShellArg(url),
    ]);
  }

  async setPermission(
    deviceId: string,
    appId: string,
    permission: string,
    grant: boolean,
  ): Promise<void> {
    const full = PERMISSION_ALIASES[permission.toLowerCase()] ?? permission;
    await this.shell(deviceId, ["pm", grant ? "grant" : "revoke", appId, full]);
  }

  // --- Device conditions ---

  async setAppearance(deviceId: string, appearance: Appearance): Promise<void> {
    await this.shell(deviceId, ["cmd", "uimode", "night", appearance === "dark" ? "yes" : "no"]);
  }

  async setOrientation(deviceId: string, orientation: Orientation): Promise<void> {
    this.metrics.delete(deviceId); // width/height swap on rotation
    await this.shell(deviceId, ["settings", "put", "system", "accelerometer_rotation", "0"]);
    await this.shell(deviceId, [
      "settings",
      "put",
      "system",
      "user_rotation",
      String(ORIENTATION_ROTATION[orientation]),
    ]);
  }

  async setLocale(deviceId: string, locale: string, appId?: string): Promise<void> {
    if (!appId) {
      throw new CapabilityError(
        "locale",
        "android",
        "Provide an appId — per-app locale uses `cmd locale set-app-locales` (Android 13+). System locale needs root.",
      );
    }
    await this.shell(deviceId, ["cmd", "locale", "set-app-locales", appId, "--locales", locale]);
  }

  async setNetwork(deviceId: string, c: NetworkCondition): Promise<void> {
    if (c.airplaneMode !== undefined) {
      await this.shell(deviceId, [
        "cmd",
        "connectivity",
        "airplane-mode",
        c.airplaneMode ? "enable" : "disable",
      ]);
    }
    if (c.wifi !== undefined) {
      await this.shell(deviceId, ["svc", "wifi", c.wifi ? "enable" : "disable"]);
    }
    if (c.cellular !== undefined) {
      await this.shell(deviceId, ["svc", "data", c.cellular ? "enable" : "disable"]);
    }
  }

  async setLocation(deviceId: string, latitude: number, longitude: number): Promise<void> {
    if (!deviceId.startsWith("emulator-")) {
      throw new CapabilityError(
        "location",
        "android",
        "Only emulators support `emu geo fix`. Physical devices need a mock-location app.",
      );
    }
    // emu geo fix takes <longitude> <latitude>
    await this.adb(deviceId, ["emu", "geo", "fix", String(longitude), String(latitude)]);
  }

  async setFontScale(deviceId: string, scale: number): Promise<void> {
    await this.shell(deviceId, ["settings", "put", "system", "font_scale", String(scale)]);
  }

  async setStatusBar(deviceId: string, o: StatusBarOverride): Promise<void> {
    await this.shell(deviceId, ["settings", "put", "global", "sysui_demo_allowed", "1"]);
    const demo = (extras: string[]) =>
      this.shell(deviceId, [
        "am",
        "broadcast",
        "-a",
        "com.android.systemui.demo",
        "-e",
        "command",
        ...extras,
      ]);
    await demo(["enter"]);
    if (o.time) {
      const hhmm = o.time.replace(/[^0-9]/g, "").padStart(4, "0").slice(0, 4);
      await demo(["clock", "-e", "hhmm", hhmm]);
    }
    if (o.batteryLevel !== undefined) {
      await demo([
        "battery",
        "-e",
        "level",
        String(o.batteryLevel),
        "-e",
        "plugged",
        String(o.batteryState === "charging" || o.batteryState === "charged"),
      ]);
    }
    if (o.wifiBars !== undefined) {
      await demo(["network", "-e", "wifi", "show", "-e", "level", String(o.wifiBars)]);
    }
    if (o.cellularBars !== undefined) {
      await demo(["network", "-e", "mobile", "show", "-e", "level", String(o.cellularBars)]);
    }
  }

  async pushNotification(): Promise<void> {
    throw new CapabilityError(
      "push",
      "android",
      "No simulator-side push injection exists for Android. Deliver via FCM with a server key + device token, or trigger your app's local notification path directly.",
    );
  }

  // --- Diagnostics ---

  async getLogs(deviceId: string, opts: LogOptions): Promise<LogResult> {
    const args = ["logcat", "-d", "-v", "time"];
    const res = await this.adb(deviceId, args, { timeoutMs: 25_000 });
    let lines = res.stdout.split("\n");

    if (opts.appId) {
      // Best-effort: filter to lines mentioning the package. (PID-precise
      // filtering would require resolving pidof first.)
      lines = lines.filter((l) => l.includes(opts.appId!));
    }
    if (opts.filter) {
      lines = lines.filter((l) => l.includes(opts.filter!));
    }
    let crashes = detectAndroidCrashes(res.stdout);
    // Scope crashes to the app when requested — otherwise unrelated process
    // crashes (e.g. system apps) would be misattributed to it.
    if (opts.appId) crashes = crashes.filter((c) => c.detail.includes(opts.appId!));
    const maxLines = opts.maxLines ?? 400;
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
    return { lines, crashes, backend: "logcat" };
  }
}

function detectAndroidCrashes(log: string): CrashReport[] {
  const lines = log.split("\n");
  const crashes: CrashReport[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes("FATAL EXCEPTION")) {
      const detail = lines.slice(i, i + 15).join("\n");
      crashes.push({
        kind: "fatal-exception",
        summary: lines[i + 1]?.trim() || line.trim(),
        detail,
      });
    } else if (/ANR in /.test(line)) {
      crashes.push({ kind: "anr", summary: line.trim(), detail: lines.slice(i, i + 8).join("\n") });
    }
  }
  return crashes;
}

export { ExecError };
