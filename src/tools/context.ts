import { DriverRegistry } from "../drivers/registry.js";
import { SessionRecorder } from "../core/session.js";
import { centerOf, diffScreens, findElements, toCompactJson, toSalientJson } from "../core/hierarchy.js";
import {
  centerOfWord,
  findOcrText,
  ocrEngine,
  ocrImage,
  pngPixelSize,
  scaleOcrWords,
  type OcrWord,
} from "../core/ocr.js";
import type { Screen } from "../drivers/types.js";
import type { Selector } from "../core/flow.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ObserveMode = "none" | "screen" | "diff" | "screenshot";

export interface ResolvedTarget {
  x: number;
  y: number;
  selector?: Selector; // for flow recording (resilient replay)
  label: string; // human-readable, for the session log
  matchCount: number;
  ocrUsed?: boolean;
}

export interface TargetInput {
  x?: number;
  y?: number;
  id?: string;
  text?: string;
  resource_id?: string;
  accessibility?: string;
  index?: number;
  /** Force OCR (screenshot text-location) instead of the accessibility tree. */
  ocr?: boolean;
}

/** Shared state + helpers across all tools. */
export class AppContext {
  readonly registry = new DriverRegistry();
  readonly recorder = new SessionRecorder();
  private readonly lastScreen = new Map<string, Screen>();

  rememberScreen(screen: Screen): void {
    this.lastScreen.set(screen.deviceId, screen);
  }

  /** When report-capture is on, screenshot the device and attach it to the last step. */
  async captureForReport(deviceId: string): Promise<void> {
    if (!this.recorder.richCapture) return;
    this.recorder.noteDevice(deviceId);
    try {
      const png = await this.registry.driverFor(deviceId).screenshot(deviceId);
      this.recorder.attachScreenshot(png.toString("base64"));
    } catch {
      /* best-effort; a missing screenshot just shows as "no screenshot" */
    }
  }

  /**
   * Resolve an action target to coordinates. Accepts raw {x,y} or a selector
   * ({id,text,resource_id,accessibility}). With a selector we inspect, find the
   * element, and tap its center — and remember the selector so the recorded
   * flow replays resiliently instead of by brittle coordinates.
   */
  async resolveTarget(deviceId: string, t: TargetInput): Promise<ResolvedTarget> {
    if (typeof t.x === "number" && typeof t.y === "number") {
      return { x: t.x, y: t.y, label: `point (${t.x}, ${t.y})`, matchCount: 1 };
    }
    // Forced OCR: skip the accessibility tree entirely (e.g. canvas/game UIs).
    if (t.ocr) {
      if (!t.text) throw new Error("ocr targeting needs `text` to locate on screen.");
      const r = await this.ocrTarget(deviceId, t.text, t.index ?? 0);
      if (!r) throw new Error(`OCR found no text matching "${t.text}".`);
      return r;
    }
    const driver = this.registry.driverFor(deviceId);
    const screen = await driver.inspect(deviceId);
    this.rememberScreen(screen);
    const matches = findElements(screen, {
      id: t.id,
      text: t.text,
      resourceId: t.resource_id,
      accessibility: t.accessibility,
    });
    if (matches.length === 0) {
      // Fall back to OCR when the a11y tree has no match but we have text to find.
      if (t.text && (await ocrEngine())) {
        const r = await this.ocrTarget(deviceId, t.text, t.index ?? 0);
        if (r) return r;
      }
      throw new Error(
        `No element matched ${JSON.stringify(t)}. Call inspect_screen to see available elements${
          t.text ? " (or it may not be in the accessibility tree — OCR found nothing either)" : ""
        }.`,
      );
    }
    const idx = t.index ?? 0;
    const el = matches[idx];
    if (!el) {
      throw new Error(`index ${idx} out of range — only ${matches.length} element(s) matched.`);
    }
    const { x, y } = centerOf(el);
    const selector: Selector = {};
    if (t.id) {
      // id is our synthetic id; record by the element's text/resourceId for replay.
      if (el.resourceId) selector.id = el.resourceId;
      else if (el.text) selector.text = el.text;
      else if (el.accessibility) selector.text = el.accessibility;
    } else {
      if (t.resource_id || el.resourceId) selector.id = t.resource_id ?? el.resourceId;
      else if (t.text) selector.text = t.text;
      else if (t.accessibility || el.accessibility) selector.text = t.accessibility ?? el.accessibility;
    }
    if (t.index !== undefined) selector.index = t.index;
    const label = el.text || el.accessibility || el.resourceId || el.id;
    return {
      x,
      y,
      selector: Object.keys(selector).length ? selector : undefined,
      label: `"${label}"`,
      matchCount: matches.length,
    };
  }

  /**
   * OCR the current screen and return all (optionally filtered) text runs, with
   * coordinates mapped into the tap/hierarchy space. OCR runs on the screenshot
   * (pixels), but taps and `inspect_screen` use the driver's coordinate space —
   * pixels on Android (1:1), logical points on iOS (Retina ÷2/÷3). We match in
   * pixel space (so adjacent-run stitching is unchanged) then scale the result,
   * so an OCR-located target taps the right place on every platform.
   */
  async ocrScreen(deviceId: string, query?: string): Promise<OcrWord[]> {
    const driver = this.registry.driverFor(deviceId);
    const png = await driver.screenshot(deviceId);
    const words = await ocrImage(png);
    const matched = query ? findOcrText(words, query) : words;
    return scaleOcrWords(matched, await this.ocrScale(deviceId, png, driver));
  }

  /** Screenshot-pixels per tap-space unit (1 on Android; Retina factor on iOS). */
  private async ocrScale(
    deviceId: string,
    png: Buffer,
    driver: ReturnType<DriverRegistry["driverFor"]>,
  ): Promise<number> {
    try {
      const px = pngPixelSize(png);
      const size = await driver.screenSize(deviceId);
      if (px?.width && size.width) return px.width / size.width;
    } catch {
      /* unknown → no scaling */
    }
    return 1;
  }

  /** Locate `text` visually via OCR and return it as a tappable target. */
  private async ocrTarget(
    deviceId: string,
    text: string,
    index: number,
  ): Promise<ResolvedTarget | null> {
    const matches = await this.ocrScreen(deviceId, text);
    if (matches.length === 0) return null;
    const word = matches[index] ?? matches[0]!;
    const { x, y } = centerOfWord(word);
    return {
      x,
      y,
      // Record as a text selector — Maestro's tapOn also matches visible text.
      selector: { text, ...(index ? { index } : {}) },
      label: `OCR "${word.text}"`,
      matchCount: matches.length,
      ocrUsed: true,
    };
  }

  /** Build the act+observe response: confirm + optional fresh state in one trip. */
  async observe(deviceId: string, mode: ObserveMode, confirm: string): Promise<ContentBlock[]> {
    // If a report is being recorded, snapshot the post-action screen (no-op otherwise).
    await this.captureForReport(deviceId);
    const blocks: ContentBlock[] = [{ type: "text", text: confirm }];
    const driver = this.registry.driverFor(deviceId);

    if (mode === "none") return blocks;

    if (mode === "screenshot") {
      try {
        const png = await driver.screenshot(deviceId);
        blocks.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
      } catch (err) {
        blocks.push({ type: "text", text: `(screenshot failed: ${errMessage(err)})` });
      }
      return blocks;
    }

    // "screen" or "diff" both require a fresh inspect.
    let after: Screen;
    try {
      after = await driver.inspect(deviceId);
    } catch (err) {
      blocks.push({ type: "text", text: `(could not inspect after action: ${errMessage(err)})` });
      return blocks;
    }

    if (mode === "diff") {
      const before = this.lastScreen.get(deviceId);
      this.rememberScreen(after);
      if (before) {
        const diff = diffScreens(before, after);
        blocks.push({
          type: "text",
          text: `Screen changes since last inspect:\n${JSON.stringify(diff, null, 2)}`,
        });
        return blocks;
      }
      blocks.push({ type: "text", text: "(no prior screen to diff against; full screen below)" });
    } else {
      this.rememberScreen(after);
    }

    // Full compact tree — but some screens (soft keyboard up, long lists) produce
    // a tree far larger than the MCP response budget, which fails the whole call.
    // If the full tree is too big, fall back to a flattened salient-only view so
    // the agent still gets the new state (targets) in one trip instead of an error.
    let payload = JSON.stringify(toCompactJson(after), null, 2);
    if (payload.length > MAX_INLINE_SCREEN_CHARS) {
      payload = JSON.stringify(toSalientJson(after), null, 2);
    }
    blocks.push({ type: "text", text: payload });
    return blocks;
  }
}

/**
 * Upper bound on an inline act+observe screen payload (characters). Above this we
 * switch to the salient-only view. Kept well under typical MCP token limits
 * (~1 token ≈ 4 chars) so even a verbose screen returns cleanly.
 */
const MAX_INLINE_SCREEN_CHARS = 24_000;

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let sharedContext: AppContext | undefined;
export function getContext(): AppContext {
  if (!sharedContext) sharedContext = new AppContext();
  return sharedContext;
}
