import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRun, exec } from "../util/exec.js";

/**
 * Thin wrapper over the `maestro` CLI, used under the hood for local flow
 * execution (run_flow) and as a hierarchy/interaction fallback. The faster
 * act+observe tools sit on top via the platform drivers; reusing this engine
 * means flows exported by export_flow run unchanged with the standard toolchain.
 */

export async function maestroAvailable(): Promise<boolean> {
  return canRun("maestro", ["--version"]);
}

export interface RunFlowOptions {
  deviceId?: string;
  yaml?: string;
  files?: string[];
  dir?: string;
  includeTags?: string[];
  excludeTags?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunFlowResult {
  success: boolean;
  exitCode: number | null;
  output: string;
}

export async function runFlow(opts: RunFlowOptions): Promise<RunFlowResult> {
  const provided = [opts.yaml, opts.files, opts.dir].filter((x) =>
    Array.isArray(x) ? x.length > 0 : Boolean(x),
  );
  if (provided.length !== 1) {
    throw new Error("Provide exactly one of: yaml, files, or dir.");
  }

  let tempDir: string | undefined;
  const targets: string[] = [];
  try {
    if (opts.yaml) {
      tempDir = await mkdtemp(join(tmpdir(), "manos-flow-"));
      const file = join(tempDir, "flow.yaml");
      await writeFile(file, opts.yaml, "utf8");
      targets.push(file);
    } else if (opts.files) {
      targets.push(...opts.files);
    } else if (opts.dir) {
      targets.push(opts.dir);
    }

    const args: string[] = [];
    if (opts.deviceId) args.push("--device", opts.deviceId);
    args.push("test");
    if (opts.includeTags?.length) args.push("--include-tags", opts.includeTags.join(","));
    if (opts.excludeTags?.length) args.push("--exclude-tags", opts.excludeTags.join(","));
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(...targets);

    const res = await exec("maestro", args, {
      timeoutMs: opts.timeoutMs ?? 300_000,
      allowNonZero: true,
    });
    return {
      success: res.code === 0,
      exitCode: res.code,
      output: `${res.stdout}\n${res.stderr}`.trim(),
    };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

export function cheatSheet(): string {
  return `Maestro flow cheat sheet (compatible with run_flow / export_flow)

A flow is a YAML file: an "appId:" header, then "---", then a list of commands.

  appId: com.example.app
  ---
  - launchApp
  - tapOn: "Login"
  - tapOn:
      id: "email_field"
  - inputText: "user@example.com"
  - tapOn: "Continue"
  - assertVisible: "Welcome"

Common commands:
  - launchApp                      Launch appId (add clearState: true to reset)
  - tapOn / longPressOn            Selector: text string, or { id, index, point }
  - inputText / eraseText          Type into focused field / delete N chars
  - swipe                          { direction: UP|DOWN|LEFT|RIGHT } or start/end points
  - scroll / scrollUntilVisible    Scroll the screen / until an element appears
  - back                           Android back (no-op on iOS)
  - pressKey: Enter                Named key press
  - assertVisible / assertNotVisible   Selector assertions
  - extendedWaitUntil:             { visible|notVisible: <selector>, timeout: <ms> }
  - openLink: "myapp://path"       Deep link
  - takeScreenshot: "name"         Save a screenshot

Selectors match by visible text by default. Prefer id or accessibility text for
stability. Copy text verbatim from inspect_screen output — never retype from a
screenshot. Abbreviated inspect keys (txt/rid/a11y) are NOT valid selector keys;
use text / id / index / point.

Tip: use this server's act+observe tools (tap, input_text, swipe, assert,
wait_for) for fast interactive exploration, then export_flow to turn the session
into a reusable flow like the one above.`;
}
