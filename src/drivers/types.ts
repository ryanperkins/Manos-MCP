export type Platform = "android" | "ios";

export type DeviceType = "emulator" | "simulator" | "physical";

export interface Device {
  id: string; // adb serial or simctl UDID
  name: string;
  platform: Platform;
  type: DeviceType;
  osVersion?: string;
  state: "booted" | "shutdown" | "unknown";
}

/**
 * The set of things a driver can do on a given device. Tools check the
 * relevant capability before acting so the agent gets a clear, actionable
 * message instead of an opaque subprocess error.
 */
export type Capability =
  | "inspect"
  | "screenshot"
  | "tap"
  | "input_text"
  | "swipe"
  | "press_key"
  | "launch"
  | "stop"
  | "clear_state"
  | "deeplink"
  | "permissions"
  | "appearance"
  | "orientation"
  | "locale"
  | "network"
  | "location"
  | "font_scale"
  | "status_bar"
  | "push"
  | "logs";

/** Reported support level for a capability on a platform. */
export type SupportLevel = "full" | "partial" | "unavailable";

export interface CapabilityInfo {
  level: SupportLevel;
  /** Why it is partial/unavailable, and how to enable it. */
  note?: string;
  /** The underlying mechanism, e.g. "adb shell input tap" or "simctl ui". */
  backend?: string;
}

export type CapabilityMap = Record<Capability, CapabilityInfo>;

export class CapabilityError extends Error {
  constructor(
    readonly capability: Capability,
    readonly platform: Platform,
    note?: string,
  ) {
    super(
      `Capability "${capability}" is not available on ${platform}` +
        (note ? `: ${note}` : "."),
    );
    this.name = "CapabilityError";
  }
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiElement {
  /** Stable id derived from element identity (see hierarchy.ts). */
  id: string;
  cls?: string;
  text?: string;
  resourceId?: string;
  accessibility?: string; // content-desc (Android) / a11y label (iOS)
  hint?: string;
  value?: string; // iOS value, e.g. switch/slider state
  bounds: Bounds;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  checked: boolean;
  scrollable: boolean;
  children: UiElement[];
}

export interface Screen {
  platform: Platform;
  deviceId: string;
  width: number;
  height: number;
  /** Android screen density in DPI (160 = 1x). Undefined on iOS (points are 1:1). */
  densityDpi?: number;
  root: UiElement[];
  /** Flattened, depth-first — convenient for search & diffing. */
  flat: UiElement[];
  capturedAt: string; // ISO timestamp
}

export interface LogOptions {
  /** Only return lines mentioning this package/bundle id where supported. */
  appId?: string;
  /** Limit to roughly this many recent lines. */
  maxLines?: number;
  /** Substring filter applied to each line. */
  filter?: string;
  /** Time window in seconds to look back (where the backend supports it). */
  sinceSeconds?: number;
}

export interface LogResult {
  lines: string[];
  /** Detected crashes / ANRs / fatal exceptions with extracted context. */
  crashes: CrashReport[];
  backend: string;
}

export interface CrashReport {
  kind: "crash" | "anr" | "fatal-exception";
  summary: string;
  detail: string;
}

export interface StatusBarOverride {
  time?: string; // e.g. "9:41"
  batteryLevel?: number; // 0-100
  batteryState?: "charging" | "charged" | "discharging";
  cellularBars?: number; // 0-4
  wifiBars?: number; // 0-3
  operatorName?: string;
}

export interface NetworkCondition {
  wifi?: boolean;
  cellular?: boolean;
  airplaneMode?: boolean;
}

export type Orientation = "portrait" | "landscape-left" | "landscape-right" | "upside-down";
export type Appearance = "light" | "dark";

/**
 * The platform driver contract. Every method may throw CapabilityError when
 * the device/platform can't support it; tools surface that to the agent.
 */
export interface Driver {
  readonly platform: Platform;

  listDevices(): Promise<Device[]>;
  capabilities(deviceId: string): Promise<CapabilityMap>;

  // --- Observe ---
  inspect(deviceId: string): Promise<Screen>;
  screenshot(deviceId: string): Promise<Buffer>; // PNG bytes
  /**
   * Screen size in the driver's tap/hierarchy coordinate space: pixels on
   * Android, logical points on iOS. Used to map screenshot/OCR pixels into the
   * space taps expect. `{ width: 0 }` means unknown (callers should no-op).
   */
  screenSize(deviceId: string): Promise<{ width: number; height: number }>;

  // --- Act ---
  tap(deviceId: string, x: number, y: number): Promise<void>;
  longPress(deviceId: string, x: number, y: number, durationMs: number): Promise<void>;
  inputText(deviceId: string, text: string, opts?: { perCharDelayMs?: number }): Promise<void>;
  swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<void>;
  pressKey(deviceId: string, key: string): Promise<void>;

  // --- App lifecycle / state ---
  launchApp(deviceId: string, appId: string, args?: string[]): Promise<void>;
  stopApp(deviceId: string, appId: string): Promise<void>;
  clearAppState(deviceId: string, appId: string): Promise<void>;
  openDeeplink(deviceId: string, url: string): Promise<void>;
  setPermission(
    deviceId: string,
    appId: string,
    permission: string,
    grant: boolean,
  ): Promise<void>;

  // --- Device conditions ---
  setAppearance(deviceId: string, appearance: Appearance): Promise<void>;
  setOrientation(deviceId: string, orientation: Orientation): Promise<void>;
  setLocale(deviceId: string, locale: string, appId?: string): Promise<void>;
  setNetwork(deviceId: string, condition: NetworkCondition): Promise<void>;
  setLocation(deviceId: string, latitude: number, longitude: number): Promise<void>;
  setFontScale(deviceId: string, scale: number): Promise<void>;
  setStatusBar(deviceId: string, override: StatusBarOverride): Promise<void>;
  pushNotification(deviceId: string, appId: string, payload: unknown): Promise<void>;

  // --- Diagnostics ---
  getLogs(deviceId: string, opts: LogOptions): Promise<LogResult>;
}

/** Map an Android keyevent / iOS key name from a friendly alias. */
export const KEY_ALIASES = [
  "back",
  "home",
  "enter",
  "tab",
  "delete",
  "backspace",
  "search",
  "menu",
  "power",
  "volume_up",
  "volume_down",
  "lock",
  "app_switch",
] as const;
export type KeyName = (typeof KEY_ALIASES)[number];
