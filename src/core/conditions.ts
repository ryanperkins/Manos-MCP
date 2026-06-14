import {
  CapabilityError,
  type Appearance,
  type Driver,
  type NetworkCondition,
  type Orientation,
  type StatusBarOverride,
} from "../drivers/types.js";

/**
 * A bundle of device conditions applied together. Lets the agent put a device
 * into a real-world state (offline, dark, large text, a foreign locale, a clean
 * status bar) in one call instead of orchestrating six tools — the edge-case
 * states where bugs actually live.
 */
export interface ConditionSet {
  appearance?: Appearance;
  orientation?: Orientation;
  locale?: string;
  fontScale?: number;
  network?: NetworkCondition;
  location?: { latitude: number; longitude: number };
  statusBar?: StatusBarOverride;
}

/** Named starting points; explicit fields on the tool call override these. */
export const PRESETS: Record<string, { description: string; conditions: ConditionSet }> = {
  reset: {
    description: "Restore defaults: light mode, 1.0 text, online.",
    conditions: {
      appearance: "light",
      fontScale: 1.0,
      orientation: "portrait",
      network: { wifi: true, cellular: true, airplaneMode: false },
    },
  },
  screenshot: {
    description: "Clean marketing state: light mode + a pristine 9:41 status bar.",
    conditions: {
      appearance: "light",
      statusBar: {
        time: "9:41",
        batteryLevel: 100,
        batteryState: "charged",
        cellularBars: 4,
        wifiBars: 3,
      },
    },
  },
  accessibility: {
    description: "Accessibility stress: largest text + dark mode.",
    conditions: { fontScale: 2.0, appearance: "dark" },
  },
  offline: {
    description: "No connectivity (airplane mode / radios off).",
    conditions: { network: { airplaneMode: true, wifi: false, cellular: false } },
  },
  dark: {
    description: "Dark appearance.",
    conditions: { appearance: "dark" },
  },
  international: {
    description: "Foreign locale (defaults to fr-FR; override with `locale`). Needs app_id.",
    conditions: { locale: "fr-FR" },
  },
};

export type ConditionStatus = "applied" | "skipped" | "failed";
export interface ConditionResult {
  condition: string;
  status: ConditionStatus;
  detail?: string;
}

/**
 * Apply each provided condition, collecting a per-condition result. A condition
 * unsupported on the platform is reported as "skipped" (with the reason), not a
 * hard failure — so the agent sees exactly what took effect.
 */
export async function applyConditions(
  driver: Driver,
  deviceId: string,
  set: ConditionSet,
  appId?: string,
): Promise<ConditionResult[]> {
  const results: ConditionResult[] = [];
  const run = async (name: string, value: unknown, fn: () => Promise<void>) => {
    if (value === undefined) return;
    try {
      await fn();
      results.push({ condition: name, status: "applied", detail: describe(name, value) });
    } catch (err) {
      if (err instanceof CapabilityError) {
        results.push({ condition: name, status: "skipped", detail: err.message });
      } else {
        results.push({
          condition: name,
          status: "failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // Apply locale last — it may relaunch the app on iOS, which would reset other
  // conditions if done first.
  await run("appearance", set.appearance, () => driver.setAppearance(deviceId, set.appearance!));
  await run("fontScale", set.fontScale, () => driver.setFontScale(deviceId, set.fontScale!));
  await run("orientation", set.orientation, () =>
    driver.setOrientation(deviceId, set.orientation!),
  );
  await run("network", set.network, () => driver.setNetwork(deviceId, set.network!));
  await run("location", set.location, () =>
    driver.setLocation(deviceId, set.location!.latitude, set.location!.longitude),
  );
  await run("statusBar", set.statusBar, () => driver.setStatusBar(deviceId, set.statusBar!));
  await run("locale", set.locale, () => driver.setLocale(deviceId, set.locale!, appId));

  return results;
}

function describe(name: string, value: unknown): string {
  if (name === "network") {
    const n = value as NetworkCondition;
    return Object.entries(n)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  }
  if (name === "location") {
    const l = value as { latitude: number; longitude: number };
    return `${l.latitude}, ${l.longitude}`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Merge a preset's conditions with explicit overrides. Only *defined* explicit
 * fields override — otherwise an absent field would wipe the preset's value.
 */
export function resolveConditions(preset: string | undefined, explicit: ConditionSet): ConditionSet {
  const base = preset ? (PRESETS[preset]?.conditions ?? {}) : {};
  const defined = (o: object): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const merged: ConditionSet = { ...base, ...(defined(explicit) as Partial<ConditionSet>) };
  const network = { ...base.network, ...defined(explicit.network ?? {}) };
  merged.network = Object.keys(network).length ? (network as NetworkCondition) : undefined;
  return merged;
}
