import { exec } from "../util/exec.js";
import { runFlow } from "./maestro.js";
import { maestroSession } from "./maestroSession.js";
import type { Bounds } from "../drivers/types.js";
import type { RawElement } from "./hierarchy.js";

/**
 * Maestro-backed device control, used as a robust, cross-platform fallback:
 *  - `maestro hierarchy` reliably dumps the view tree on both Android and iOS,
 *    avoiding the single-UiAutomation-connection conflict that makes raw
 *    `uiautomator dump` flaky, and avoiding the need for idb on iOS.
 *  - one-shot flows drive tap/input/swipe/key when a faster native backend
 *    (adb / idb) isn't available.
 * It is slower (JVM cold-start per call) but works with only the maestro CLI.
 */

function parseBounds(raw: string): Bounds | null {
  const m = raw.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

interface MaestroNode {
  attributes?: Record<string, string>;
  children?: MaestroNode[];
}

/** Expand a maestro node into RawElements, hoisting bounds-less wrappers. */
function expand(node: MaestroNode): RawElement[] {
  const a = node.attributes ?? {};
  const childRaws = (node.children ?? []).flatMap(expand);
  const bounds = parseBounds(a.bounds ?? "");
  if (!bounds) return childRaws; // wrapper node: lift its children up
  const text = (a.text ?? "").trim() || undefined;
  const acc = (a.accessibilityText ?? "").trim() || undefined;
  return [
    {
      cls: a.class || undefined,
      text,
      resourceId: a["resource-id"] || undefined,
      accessibility: acc,
      hint: (a.hintText ?? "").trim() || undefined,
      bounds,
      clickable: a.clickable === "true",
      enabled: a.enabled !== "false",
      focused: a.focused === "true",
      selected: a.selected === "true",
      checked: a.checked === "true",
      scrollable: a.scrollable === "true",
      children: childRaws,
    },
  ];
}

export interface MaestroHierarchyResult {
  raw: RawElement[];
  width: number;
  height: number;
}

export async function maestroHierarchy(deviceId: string): Promise<MaestroHierarchyResult> {
  const res = await exec("maestro", ["--udid", deviceId, "hierarchy"], { timeoutMs: 60_000 });
  // maestro prints JVM warnings to stderr; the JSON tree is on stdout.
  const start = res.stdout.indexOf("{");
  if (start < 0) throw new Error("maestro hierarchy returned no JSON");
  const tree = JSON.parse(res.stdout.slice(start)) as MaestroNode;
  const raw = expand(tree);

  // Derive screen size from the widest/tallest element bounds.
  let width = 0;
  let height = 0;
  const walk = (els: RawElement[]) => {
    for (const el of els) {
      width = Math.max(width, el.bounds.x + el.bounds.width);
      height = Math.max(height, el.bounds.y + el.bounds.height);
      walk(el.children);
    }
  };
  walk(raw);
  return { raw, width, height };
}

// --- One-shot action flows ---

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function runAction(deviceId: string, appId: string, body: string): Promise<void> {
  const yaml = `appId: ${appId}\n---\n${body}\n`;
  // Prefer the warm session; fall back to a cold `maestro test` invocation.
  if (await maestroSession.run(deviceId, yaml)) return;
  const res = await runFlow({ deviceId, yaml, timeoutMs: 60_000 });
  if (!res.success) throw new Error(`Maestro action failed:\n${res.output}`);
}

export function maestroTap(deviceId: string, appId: string, x: number, y: number): Promise<void> {
  return runAction(deviceId, appId, `- tapOn:\n    point: "${x},${y}"`);
}

export function maestroLongPress(
  deviceId: string,
  appId: string,
  x: number,
  y: number,
): Promise<void> {
  return runAction(deviceId, appId, `- longPressOn:\n    point: "${x},${y}"`);
}

export function maestroInputText(deviceId: string, appId: string, text: string): Promise<void> {
  return runAction(deviceId, appId, `- inputText: "${esc(text)}"`);
}

export function maestroSwipe(
  deviceId: string,
  appId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  return runAction(deviceId, appId, `- swipe:\n    start: "${x1},${y1}"\n    end: "${x2},${y2}"`);
}

export function maestroPressKey(deviceId: string, appId: string, key: string): Promise<void> {
  const k = key.toLowerCase();
  if (k === "back") return runAction(deviceId, appId, `- back`);
  const named = k.charAt(0).toUpperCase() + k.slice(1);
  return runAction(deviceId, appId, `- pressKey: ${named}`);
}
