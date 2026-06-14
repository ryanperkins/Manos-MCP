import { existsSync, mkdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canRun, exec } from "../util/exec.js";

/**
 * OCR fallback for targeting elements the accessibility tree misses — styled
 * `<div>` buttons, canvas/Flutter/game UIs, WebViews with poor a11y. Manos runs
 * OCR on the screenshot and returns each text run's pixel bounding box, so an
 * agent can tap "the text it can see" even when it isn't in the hierarchy.
 *
 * Engines, in order: Apple Vision (macOS, on-device, excellent, no install) →
 * Tesseract (`brew install tesseract`, cross-platform). Vision's helper is
 * compiled once and cached.
 */

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number; // 0..1
}

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "ocr");
const VISION_SRC = join(ASSET_DIR, "vision-ocr.swift");
const CACHE_DIR = join(homedir(), ".cache", "manos");
const VISION_BIN = join(CACHE_DIR, "vision-ocr");

export type OcrEngine = "apple-vision" | "tesseract" | null;

let cachedEngine: OcrEngine | undefined;

export async function ocrEngine(): Promise<OcrEngine> {
  if (cachedEngine !== undefined) return cachedEngine;
  if (process.platform === "darwin" && (await canRun("swiftc", ["--version"]))) {
    cachedEngine = "apple-vision";
  } else if (await canRun("tesseract", ["--version"])) {
    cachedEngine = "tesseract";
  } else {
    cachedEngine = null;
  }
  return cachedEngine;
}

async function ensureVisionBinary(): Promise<string> {
  if (existsSync(VISION_BIN) && statSync(VISION_BIN).mtimeMs >= statSync(VISION_SRC).mtimeMs) {
    return VISION_BIN;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  await exec("swiftc", [VISION_SRC, "-O", "-o", VISION_BIN], { timeoutMs: 120_000 });
  if (!existsSync(VISION_BIN)) throw new Error("Failed to compile the Vision OCR helper.");
  return VISION_BIN;
}

/** Recognize text in a PNG, returning each run with a pixel bounding box. */
export async function ocrImage(png: Buffer): Promise<OcrWord[]> {
  const engine = await ocrEngine();
  if (!engine) {
    throw new Error(
      "No OCR engine available. On macOS it uses Apple Vision (needs Xcode command line tools); otherwise `brew install tesseract`.",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "manos-ocr-"));
  const imgPath = join(dir, "shot.png");
  try {
    await writeFile(imgPath, png);
    if (engine === "apple-vision") {
      const bin = await ensureVisionBinary();
      const out = (await exec(bin, [imgPath], { timeoutMs: 30_000 })).stdout;
      const parsed = JSON.parse(out || "[]") as OcrWord[];
      return parsed.filter((w) => w.text.trim().length > 0);
    }
    // tesseract: TSV with word-level rows (level 5)
    const out = (await exec("tesseract", [imgPath, "stdout", "tsv"], { timeoutMs: 30_000 })).stdout;
    return parseTesseractTsv(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function parseTesseractTsv(tsv: string): OcrWord[] {
  const words: OcrWord[] = [];
  for (const line of tsv.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue; // level 5 = word
    const text = cols[11]?.trim() ?? "";
    const conf = Number(cols[10]);
    if (!text || Number.isNaN(conf) || conf < 0) continue;
    words.push({
      text,
      x: Number(cols[6]),
      y: Number(cols[7]),
      width: Number(cols[8]),
      height: Number(cols[9]),
      confidence: conf / 100,
    });
  }
  return words;
}

export function centerOfWord(w: OcrWord): { x: number; y: number } {
  return { x: Math.round(w.x + w.width / 2), y: Math.round(w.y + w.height / 2) };
}

/**
 * Find OCR runs matching a query (case-insensitive substring by default).
 * Also tries to match a multi-word query against a window of adjacent runs on
 * the same line, since Vision/Tesseract may split a label across runs.
 */
export function findOcrText(
  words: OcrWord[],
  query: string,
  opts: { exact?: boolean } = {},
): OcrWord[] {
  const q = query.trim().toLowerCase();
  const direct = words.filter((w) =>
    opts.exact ? w.text.toLowerCase() === q : w.text.toLowerCase().includes(q),
  );
  if (direct.length || opts.exact) return direct;

  // Stitch adjacent runs on the same line and re-test (handles split labels).
  const byLine = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: OcrWord[] = [];
  for (let i = 0; i < byLine.length; i++) {
    let acc = byLine[i]!;
    let text = acc.text;
    for (let j = i + 1; j < byLine.length; j++) {
      const next = byLine[j]!;
      const sameLine = Math.abs(next.y - acc.y) <= acc.height * 0.6;
      const close = next.x - (acc.x + acc.width) <= acc.height * 1.5;
      if (!sameLine || !close) break;
      text += " " + next.text;
      const x = Math.min(acc.x, next.x);
      const y = Math.min(acc.y, next.y);
      acc = {
        text,
        x,
        y,
        width: Math.max(acc.x + acc.width, next.x + next.width) - x,
        height: Math.max(acc.y + acc.height, next.y + next.height) - y,
        confidence: Math.min(acc.confidence, next.confidence),
      };
      if (text.toLowerCase().includes(q)) merged.push(acc);
    }
  }
  return merged;
}
