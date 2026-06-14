import { createHash } from "node:crypto";
import type { Bounds, Platform, Screen, UiElement } from "../drivers/types.js";

/**
 * Builds a UiElement tree's stable ids, flattens it, and produces the compact
 * JSON the agent reads. Stable ids let the agent target an element by id across
 * act+observe round-trips and make screen diffs meaningful.
 */

export interface RawElement {
  cls?: string;
  text?: string;
  resourceId?: string;
  accessibility?: string;
  hint?: string;
  value?: string;
  bounds: Bounds;
  clickable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  scrollable?: boolean;
  children: RawElement[];
}

/** Strip volatile content (digits, times) so ids survive counters/clocks. */
function normalizeText(text?: string): string {
  if (!text) return "";
  return text
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .toLowerCase();
}

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 6);
}

/**
 * Assigns stable ids and returns a finalized Screen. The id is a hash of an
 * element's semantic identity (resource-id / a11y / class + normalized text),
 * NOT its position, so a value changing (e.g. a counter) keeps the same id and
 * shows up as a "changed" element in diffs. Duplicates within one screen get a
 * numeric suffix for uniqueness.
 */
export function finalizeScreen(
  raw: RawElement[],
  meta: {
    platform: Platform;
    deviceId: string;
    width: number;
    height: number;
    densityDpi?: number;
  },
): Screen {
  const seen = new Map<string, number>();
  const flat: UiElement[] = [];

  function visit(node: RawElement): UiElement {
    const identity = [
      node.resourceId ?? "",
      node.accessibility ?? "",
      node.cls ?? "",
      normalizeText(node.text ?? node.value),
    ].join("|");
    let id = shortHash(identity);
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    if (count > 0) id = `${id}-${count + 1}`;

    const el: UiElement = {
      id,
      cls: node.cls,
      text: node.text,
      resourceId: node.resourceId,
      accessibility: node.accessibility,
      hint: node.hint,
      value: node.value,
      bounds: node.bounds,
      clickable: node.clickable ?? false,
      enabled: node.enabled ?? true,
      focused: node.focused ?? false,
      selected: node.selected ?? false,
      checked: node.checked ?? false,
      scrollable: node.scrollable ?? false,
      children: node.children.map(visit),
    };
    flat.push(el);
    return el;
  }

  const root = raw.map(visit);
  return {
    platform: meta.platform,
    deviceId: meta.deviceId,
    width: meta.width,
    height: meta.height,
    densityDpi: meta.densityDpi,
    root,
    flat,
    capturedAt: new Date().toISOString(),
  };
}

/** Center point of an element — what tap targets. */
export function centerOf(el: UiElement): { x: number; y: number } {
  return {
    x: Math.round(el.bounds.x + el.bounds.width / 2),
    y: Math.round(el.bounds.y + el.bounds.height / 2),
  };
}

export interface FindQuery {
  id?: string;
  text?: string; // case-insensitive substring
  textExact?: string;
  resourceId?: string;
  accessibility?: string;
  clickableOnly?: boolean;
}

/** Search the flattened tree. Returns matches in depth-first order. */
export function findElements(screen: Screen, q: FindQuery): UiElement[] {
  const lc = (s?: string) => (s ?? "").toLowerCase();
  return screen.flat.filter((el) => {
    if (q.id && el.id !== q.id) return false;
    if (q.clickableOnly && !el.clickable) return false;
    if (q.resourceId && lc(el.resourceId) !== lc(q.resourceId)) return false;
    if (q.accessibility && !lc(el.accessibility).includes(lc(q.accessibility))) return false;
    if (q.textExact !== undefined && (el.text ?? el.value ?? "") !== q.textExact) return false;
    if (q.text) {
      const hay = `${el.text ?? ""} ${el.value ?? ""} ${el.accessibility ?? ""}`.toLowerCase();
      if (!hay.includes(q.text.toLowerCase())) return false;
    }
    return true;
  });
}

const UI_SCHEMA = {
  abbreviations: {
    b: "bounds [x,y,w,h]",
    txt: "text",
    rid: "resource-id (Android) / identifier (iOS)",
    a11y: "accessibility label / content-desc",
    val: "value (iOS controls)",
    hint: "hint / placeholder",
    cls: "class",
    id: "stable element id (use with act tools)",
    c: "children",
  },
  defaults: {
    clickable: false,
    enabled: true,
    focused: false,
    selected: false,
    checked: false,
    scroll: false,
  },
  note: "Target elements with the 'id' field via tap/input tools, or use text/resource-id selectors. Copy text verbatim — never retype from a screenshot.",
};

type CompactNode = Record<string, unknown>;

function toCompactNode(el: UiElement): CompactNode {
  const n: CompactNode = {
    id: el.id,
    b: [el.bounds.x, el.bounds.y, el.bounds.width, el.bounds.height],
  };
  if (el.text) n.txt = el.text;
  if (el.resourceId) n.rid = el.resourceId;
  if (el.accessibility) n.a11y = el.accessibility;
  if (el.value) n.val = el.value;
  if (el.hint) n.hint = el.hint;
  if (el.cls) n.cls = el.cls;
  if (el.clickable) n.clickable = true;
  if (!el.enabled) n.enabled = false;
  if (el.focused) n.focused = true;
  if (el.selected) n.selected = true;
  if (el.checked) n.checked = true;
  if (el.scrollable) n.scroll = true;
  if (el.children.length) n.c = el.children.map(toCompactNode);
  return n;
}

export interface CompactScreen {
  ui_schema: typeof UI_SCHEMA;
  device: { platform: Platform; id: string; size: [number, number] };
  elements: CompactNode[];
}

export function toCompactJson(screen: Screen): CompactScreen {
  return {
    ui_schema: UI_SCHEMA,
    device: { platform: screen.platform, id: screen.deviceId, size: [screen.width, screen.height] },
    elements: screen.root.map(toCompactNode),
  };
}

// --- Diffing ---

export interface ScreenDiff {
  added: CompactNode[];
  removed: CompactNode[];
  changed: Array<{ id: string; changes: Record<string, [unknown, unknown]> }>;
  unchanged: number;
}

function elementSummary(el: UiElement): Record<string, unknown> {
  return {
    text: el.text ?? el.value ?? "",
    bounds: [el.bounds.x, el.bounds.y, el.bounds.width, el.bounds.height],
    enabled: el.enabled,
    checked: el.checked,
    selected: el.selected,
    focused: el.focused,
  };
}

/**
 * Diff two screens by stable id. Returns added/removed nodes and, for elements
 * present in both, the attributes that changed. Lets the agent see "what
 * happened" after an action without re-reading the full tree.
 */
export function diffScreens(before: Screen, after: Screen): ScreenDiff {
  const beforeById = new Map(before.flat.map((e) => [e.id, e]));
  const afterById = new Map(after.flat.map((e) => [e.id, e]));

  const added: CompactNode[] = [];
  const removed: CompactNode[] = [];
  const changed: ScreenDiff["changed"] = [];
  let unchanged = 0;

  for (const [id, el] of afterById) {
    if (!beforeById.has(id)) {
      added.push(toCompactNode(el));
    }
  }
  for (const [id, el] of beforeById) {
    if (!afterById.has(id)) {
      removed.push(toCompactNode(el));
      continue;
    }
    const a = elementSummary(el);
    const b = elementSummary(afterById.get(id)!);
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of Object.keys(a)) {
      const av = JSON.stringify(a[key]);
      const bv = JSON.stringify(b[key]);
      if (av !== bv) changes[key] = [a[key], b[key]];
    }
    if (Object.keys(changes).length) changed.push({ id, changes });
    else unchanged++;
  }

  return { added, removed, changed, unchanged };
}
