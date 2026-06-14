import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRun, exec } from "../util/exec.js";
import { finalizeScreen, type RawElement } from "../core/hierarchy.js";
import { maestroAvailable } from "../core/maestro.js";
import { maestroSession } from "../core/maestroSession.js";
import {
  maestroHierarchy,
  maestroInputText,
  maestroLongPress,
  maestroPressKey,
  maestroSwipe,
  maestroTap,
} from "../core/maestroDriver.js";
import {
  CapabilityError,
  type Appearance,
  type Capability,
  type CapabilityMap,
  type CrashReport,
  type Device,
  type Driver,
  type LogOptions,
  type LogResult,
  type NetworkCondition,
  type Orientation,
  type Screen,
  type StatusBarOverride,
} from "./types.js";

const PERMISSION_ALIASES: Record<string, string> = {
  camera: "camera",
  microphone: "microphone",
  photos: "photos",
  photos_add: "photos-add",
  location: "location",
  location_always: "location-always",
  contacts: "contacts",
  calendar: "calendar",
  reminders: "reminders",
  notifications: "notifications",
  motion: "motion",
  all: "all",
};

// HID usage codes for idb ui key
const HID_KEYS: Record<string, number> = {
  enter: 40,
  return: 40,
  delete: 42,
  backspace: 42,
  tab: 43,
  escape: 41,
  space: 44,
};
// idb ui button names
const HID_BUTTONS: Record<string, string> = {
  home: "HOME",
  lock: "LOCK",
  power: "LOCK",
  siri: "SIRI",
};

// Dynamic Type buckets, smallest -> largest, with an approximate scale factor.
const CONTENT_SIZES: Array<{ scale: number; name: string }> = [
  { scale: 0.82, name: "extra-small" },
  { scale: 0.88, name: "small" },
  { scale: 0.95, name: "medium" },
  { scale: 1.0, name: "large" },
  { scale: 1.12, name: "extra-large" },
  { scale: 1.23, name: "extra-extra-large" },
  { scale: 1.35, name: "extra-extra-extra-large" },
  { scale: 1.6, name: "accessibility-medium" },
  { scale: 1.9, name: "accessibility-large" },
  { scale: 2.35, name: "accessibility-extra-large" },
  { scale: 2.75, name: "accessibility-extra-extra-large" },
  { scale: 3.1, name: "accessibility-extra-extra-extra-large" },
];

function nearestContentSize(scale: number): string {
  let best = CONTENT_SIZES[0]!;
  let bestDelta = Infinity;
  for (const c of CONTENT_SIZES) {
    const d = Math.abs(c.scale - scale);
    if (d < bestDelta) {
      bestDelta = d;
      best = c;
    }
  }
  return best.name;
}

export class IosDriver implements Driver {
  readonly platform = "ios" as const;
  private idbAvailable: boolean | undefined;
  private maestroAvail: boolean | undefined;
  /** Last app launched on each device — needed for the Maestro action fallback. */
  private lastAppId = new Map<string, string>();

  private simctl(args: string[], opts?: { timeoutMs?: number; allowNonZero?: boolean }) {
    return exec("xcrun", ["simctl", ...args], {
      timeoutMs: opts?.timeoutMs ?? 30_000,
      allowNonZero: opts?.allowNonZero,
    });
  }

  private async probeIdb(): Promise<boolean> {
    if (this.idbAvailable === undefined) {
      this.idbAvailable = await canRun("idb", ["--version"]);
    }
    return this.idbAvailable;
  }

  private async probeMaestro(): Promise<boolean> {
    if (this.maestroAvail === undefined) {
      this.maestroAvail = await maestroAvailable();
    }
    return this.maestroAvail;
  }

  /** App id for the Maestro fallback; the app must have been launched first. */
  private appIdFor(deviceId: string, cap: Capability): string {
    const appId = this.lastAppId.get(deviceId);
    if (!appId) {
      throw new CapabilityError(
        cap,
        "ios",
        "Without idb, iOS UI control runs through Maestro, which needs to know the app. Call launch_app first, or install idb for direct control.",
      );
    }
    return appId;
  }

  private async noIdbError(cap: Capability): Promise<never> {
    throw new CapabilityError(
      cap,
      "ios",
      "Requires idb or Maestro. Install idb (`brew install idb-companion && pipx install fb-idb`) for fast native control, or install the maestro CLI.",
    );
  }

  private idb(args: string[], opts?: { timeoutMs?: number }) {
    return exec("idb", args, { timeoutMs: opts?.timeoutMs ?? 20_000 });
  }

  async listDevices(): Promise<Device[]> {
    let json: any;
    try {
      const out = (await this.simctl(["list", "devices", "--json"])).stdout;
      json = JSON.parse(out);
    } catch {
      return [];
    }
    const devices: Device[] = [];
    for (const [runtime, list] of Object.entries<any[]>(json.devices ?? {})) {
      const osVersion = runtime
        .replace(/.*SimRuntime\.iOS-/, "")
        .replace(/.*SimRuntime\./, "")
        .replace(/-/g, ".");
      for (const d of list) {
        if (d.isAvailable === false) continue;
        devices.push({
          id: d.udid,
          name: d.name,
          platform: "ios",
          type: "simulator",
          osVersion,
          state: d.state === "Booted" ? "booted" : "shutdown",
        });
      }
    }
    // Booted devices first.
    return devices.sort((a, b) => (a.state === "booted" ? -1 : 1) - (b.state === "booted" ? -1 : 1));
  }

  async capabilities(_deviceId: string): Promise<CapabilityMap> {
    const hasIdb = await this.probeIdb();
    const hasMaestro = await this.probeMaestro();
    // UI control prefers idb (fast, native); falls back to Maestro (slower,
    // needs the app launched first); unavailable if neither is installed.
    const uiLevel: "full" | "partial" | "unavailable" = hasIdb
      ? "full"
      : hasMaestro
        ? "partial"
        : "unavailable";
    const uiBackend = hasIdb ? "idb" : hasMaestro ? "maestro (fallback)" : "none";
    const uiNote = hasIdb
      ? undefined
      : hasMaestro
        ? "Via Maestro (slower; call launch_app first). Install idb for fast native control."
        : "Install idb (`brew install idb-companion && pipx install fb-idb`) or the maestro CLI.";
    return {
      inspect: { level: uiLevel, backend: hasIdb ? "idb ui describe-all" : "maestro hierarchy", note: uiNote },
      screenshot: { level: "full", backend: "simctl io screenshot" },
      tap: { level: uiLevel, backend: uiBackend, note: uiNote },
      input_text: { level: uiLevel, backend: uiBackend, note: uiNote },
      swipe: { level: uiLevel, backend: uiBackend, note: uiNote },
      press_key: { level: uiLevel, backend: uiBackend, note: uiNote },
      launch: { level: "full", backend: "simctl launch" },
      stop: { level: "full", backend: "simctl terminate" },
      clear_state: {
        level: "partial",
        backend: "simctl privacy reset",
        note: "Resets permissions; a full data wipe requires uninstall + reinstall (no per-app data clear on iOS sim).",
      },
      deeplink: { level: "full", backend: "simctl openurl" },
      permissions: { level: "full", backend: "simctl privacy grant/revoke" },
      appearance: { level: "full", backend: "simctl ui appearance" },
      orientation: {
        level: "unavailable",
        note: "No simctl/idb command rotates the simulator; use the Simulator menu (Cmd+Left/Right) manually.",
      },
      locale: {
        level: "partial",
        backend: "launch args -AppleLanguages/-AppleLocale",
        note: "Applied on next launch; requires an appId.",
      },
      network: {
        level: "unavailable",
        note: "The simulator shares the host network. Use Network Link Conditioner on the host to shape conditions.",
      },
      location: { level: "full", backend: "simctl location set" },
      font_scale: { level: "full", backend: "simctl ui content_size (Dynamic Type)" },
      status_bar: {
        level: "full",
        backend: "simctl status_bar override",
        note: "Rich overrides (time, battery, carrier, signal) — ideal for clean screenshots.",
      },
      push: { level: "full", backend: "simctl push", note: "Inject APNs payloads directly." },
      logs: { level: "full", backend: "simctl spawn log" },
    };
  }

  // --- Observe ---

  async inspect(deviceId: string): Promise<Screen> {
    if (await this.probeIdb()) {
      const { width, height } = await this.screenSizePoints(deviceId);
      const out = (await this.idb(["ui", "describe-all", "--udid", deviceId], { timeoutMs: 25_000 }))
        .stdout;
      const elements = parseIdbElements(out);
      const raw: RawElement[] = elements
        .map((e) => idbElementToRaw(e))
        .filter((e): e is RawElement => e !== null);
      return finalizeScreen(raw, { platform: "ios", deviceId, width, height });
    }
    if (await this.probeMaestro()) {
      // Prefer the warm session (fast after the first call); fall back to the
      // cold `maestro hierarchy` CLI.
      const warm = await maestroSession.inspect(deviceId);
      const { raw, width, height } = warm ?? (await maestroHierarchy(deviceId));
      return finalizeScreen(raw, { platform: "ios", deviceId, width, height });
    }
    return this.noIdbError("inspect");
  }

  private async screenSizePoints(deviceId: string): Promise<{ width: number; height: number }> {
    try {
      const out = (await this.idb(["describe", "--udid", deviceId, "--json"])).stdout;
      const info = JSON.parse(out);
      const dims = info.screen_dimensions ?? {};
      return {
        width: dims.width_points ?? 0,
        height: dims.height_points ?? 0,
      };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  async screenshot(deviceId: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "manos-"));
    const file = join(dir, "screenshot.png");
    try {
      await this.simctl(["io", deviceId, "screenshot", "--type", "png", file]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // --- Act ---

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    if (await this.probeIdb()) {
      await this.idb(["ui", "tap", "--udid", deviceId, String(x), String(y)]);
    } else if (await this.probeMaestro()) {
      await maestroTap(deviceId, this.appIdFor(deviceId, "tap"), x, y);
    } else {
      await this.noIdbError("tap");
    }
  }

  async longPress(deviceId: string, x: number, y: number, durationMs: number): Promise<void> {
    if (await this.probeIdb()) {
      await this.idb([
        "ui",
        "tap",
        "--udid",
        deviceId,
        "--duration",
        String(durationMs / 1000),
        String(x),
        String(y),
      ]);
    } else if (await this.probeMaestro()) {
      await maestroLongPress(deviceId, this.appIdFor(deviceId, "tap"), x, y);
    } else {
      await this.noIdbError("tap");
    }
  }

  async inputText(deviceId: string, text: string): Promise<void> {
    if (await this.probeIdb()) {
      await this.idb(["ui", "text", "--udid", deviceId, text]);
    } else if (await this.probeMaestro()) {
      await maestroInputText(deviceId, this.appIdFor(deviceId, "input_text"), text);
    } else {
      await this.noIdbError("input_text");
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
    if (await this.probeIdb()) {
      await this.idb([
        "ui",
        "swipe",
        "--udid",
        deviceId,
        "--duration",
        String(durationMs / 1000),
        String(x1),
        String(y1),
        String(x2),
        String(y2),
      ]);
    } else if (await this.probeMaestro()) {
      await maestroSwipe(deviceId, this.appIdFor(deviceId, "swipe"), x1, y1, x2, y2);
    } else {
      await this.noIdbError("swipe");
    }
  }

  async pressKey(deviceId: string, key: string): Promise<void> {
    if (await this.probeIdb()) {
      const k = key.toLowerCase();
      if (HID_BUTTONS[k]) {
        await this.idb(["ui", "button", "--udid", deviceId, HID_BUTTONS[k]!]);
        return;
      }
      const code = HID_KEYS[k];
      if (code === undefined) {
        throw new Error(
          `Key "${key}" is not supported on iOS. Supported: ${[
            ...Object.keys(HID_KEYS),
            ...Object.keys(HID_BUTTONS),
          ].join(", ")}.`,
        );
      }
      await this.idb(["ui", "key", "--udid", deviceId, String(code)]);
    } else if (await this.probeMaestro()) {
      await maestroPressKey(deviceId, this.appIdFor(deviceId, "press_key"), key);
    } else {
      await this.noIdbError("press_key");
    }
  }

  // --- App lifecycle / state ---

  async launchApp(deviceId: string, appId: string, args?: string[]): Promise<void> {
    await this.simctl(["launch", deviceId, appId, ...(args ?? [])]);
    this.lastAppId.set(deviceId, appId);
  }

  async stopApp(deviceId: string, appId: string): Promise<void> {
    await this.simctl(["terminate", deviceId, appId], { allowNonZero: true });
  }

  async clearAppState(deviceId: string, appId: string): Promise<void> {
    await this.simctl(["terminate", deviceId, appId], { allowNonZero: true });
    await this.simctl(["privacy", deviceId, "reset", "all", appId], { allowNonZero: true });
  }

  async openDeeplink(deviceId: string, url: string): Promise<void> {
    await this.simctl(["openurl", deviceId, url]);
  }

  async setPermission(
    deviceId: string,
    appId: string,
    permission: string,
    grant: boolean,
  ): Promise<void> {
    const service = PERMISSION_ALIASES[permission.toLowerCase()] ?? permission;
    await this.simctl(["privacy", deviceId, grant ? "grant" : "revoke", service, appId]);
  }

  // --- Device conditions ---

  async setAppearance(deviceId: string, appearance: Appearance): Promise<void> {
    await this.simctl(["ui", deviceId, "appearance", appearance]);
  }

  async setOrientation(_deviceId: string, _orientation: Orientation): Promise<void> {
    throw new CapabilityError(
      "orientation",
      "ios",
      "No CLI rotates the simulator. Rotate via the Simulator menu (Cmd+Left/Right).",
    );
  }

  async setLocale(deviceId: string, locale: string, appId?: string): Promise<void> {
    if (!appId) {
      throw new CapabilityError(
        "locale",
        "ios",
        "Provide an appId — locale is applied by relaunching with -AppleLanguages/-AppleLocale.",
      );
    }
    const lang = locale.split(/[-_]/)[0];
    await this.simctl(["terminate", deviceId, appId], { allowNonZero: true });
    await this.simctl([
      "launch",
      deviceId,
      appId,
      "-AppleLanguages",
      `(${lang})`,
      "-AppleLocale",
      locale.replace("-", "_"),
    ]);
    this.lastAppId.set(deviceId, appId);
  }

  async setNetwork(_deviceId: string, _condition: NetworkCondition): Promise<void> {
    throw new CapabilityError(
      "network",
      "ios",
      "The simulator shares the host network. Use Network Link Conditioner on the host to shape conditions.",
    );
  }

  async setLocation(deviceId: string, latitude: number, longitude: number): Promise<void> {
    await this.simctl(["location", deviceId, "set", `${latitude},${longitude}`]);
  }

  async setFontScale(deviceId: string, scale: number): Promise<void> {
    await this.simctl(["ui", deviceId, "content_size", nearestContentSize(scale)]);
  }

  async setStatusBar(deviceId: string, o: StatusBarOverride): Promise<void> {
    const args = ["status_bar", deviceId, "override"];
    if (o.time) args.push("--time", o.time);
    if (o.batteryLevel !== undefined) args.push("--batteryLevel", String(o.batteryLevel));
    if (o.batteryState) {
      const state =
        o.batteryState === "charging"
          ? "charging"
          : o.batteryState === "charged"
            ? "charged"
            : "discharging";
      args.push("--batteryState", state);
    }
    if (o.cellularBars !== undefined) args.push("--cellularBars", String(o.cellularBars));
    if (o.wifiBars !== undefined) args.push("--wifiBars", String(o.wifiBars));
    if (o.operatorName) args.push("--operatorName", o.operatorName);
    await this.simctl(args);
  }

  async pushNotification(deviceId: string, appId: string, payload: unknown): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "manos-push-"));
    const file = join(dir, "payload.apns");
    try {
      await writeFile(file, JSON.stringify(payload), "utf8");
      await this.simctl(["push", deviceId, appId, file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // --- Diagnostics ---

  async getLogs(deviceId: string, opts: LogOptions): Promise<LogResult> {
    const minutes = Math.max(1, Math.ceil((opts.sinceSeconds ?? 120) / 60));
    const args = [
      "spawn",
      deviceId,
      "log",
      "show",
      "--style",
      "compact",
      "--last",
      `${minutes}m`,
    ];
    if (opts.appId) {
      // Predicate on the process name; appId's last path component is a decent guess.
      const proc = opts.appId.split(".").pop() ?? opts.appId;
      args.push("--predicate", `process CONTAINS[c] "${proc}"`);
    }
    const res = await this.simctl(args, { timeoutMs: 40_000, allowNonZero: true });
    let lines = res.stdout.split("\n");
    if (opts.filter) lines = lines.filter((l) => l.includes(opts.filter!));
    let crashes = detectIosCrashes(res.stdout);
    if (opts.appId) {
      const proc = opts.appId.split(".").pop() ?? opts.appId;
      crashes = crashes.filter((c) => c.detail.includes(opts.appId!) || c.detail.includes(proc));
    }
    const maxLines = opts.maxLines ?? 400;
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
    return { lines, crashes, backend: "simctl spawn log show" };
  }
}

// --- idb parsing helpers ---

interface IdbElement {
  AXLabel?: string;
  AXValue?: string;
  AXUniqueId?: string;
  type?: string;
  role?: string;
  role_description?: string;
  enabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
}

/** idb may emit a JSON array or newline-delimited JSON objects. Handle both. */
function parseIdbElements(out: string): IdbElement[] {
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through to JSONL */
  }
  const elements: IdbElement[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      elements.push(JSON.parse(l));
    } catch {
      /* skip malformed line */
    }
  }
  return elements;
}

function idbElementToRaw(e: IdbElement): RawElement | null {
  const f = e.frame;
  if (!f) return null;
  if (f.width <= 0 || f.height <= 0) return null;
  return {
    cls: e.type ?? e.role ?? e.role_description,
    text: e.AXLabel || undefined,
    accessibility: e.AXLabel || undefined,
    value: e.AXValue || undefined,
    bounds: {
      x: Math.round(f.x),
      y: Math.round(f.y),
      width: Math.round(f.width),
      height: Math.round(f.height),
    },
    enabled: e.enabled !== false,
    clickable: /button|cell|link|tab/i.test(e.type ?? e.role ?? ""),
    children: [],
  };
}

function detectIosCrashes(log: string): CrashReport[] {
  const lines = log.split("\n");
  const crashes: CrashReport[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/(EXC_BAD_ACCESS|SIGABRT|Fatal error|Thread \d+ Crashed|__exceptionPreprocess)/.test(line)) {
      crashes.push({
        kind: "crash",
        summary: line.trim().slice(0, 200),
        detail: lines.slice(i, i + 12).join("\n"),
      });
    }
  }
  return crashes;
}
