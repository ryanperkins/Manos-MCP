import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canRun, exec } from "./exec.js";

/**
 * Locates the external binaries the drivers depend on. `adb` is frequently
 * installed by Android Studio but left off PATH, so we probe the common SDK
 * locations before giving up.
 */

let cachedAdb: string | undefined;

export function resolveAdb(): string {
  if (cachedAdb) return cachedAdb;

  const candidates: string[] = [];
  const envRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
    (x): x is string => Boolean(x),
  );
  for (const root of envRoots) {
    candidates.push(join(root, "platform-tools", "adb"));
  }
  candidates.push(join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb")); // macOS
  candidates.push(join(homedir(), "Android", "Sdk", "platform-tools", "adb")); // Linux
  candidates.push(
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Android",
      "Sdk",
      "platform-tools",
      "adb.exe",
    ),
  ); // Windows

  for (const c of candidates) {
    if (existsSync(c)) {
      cachedAdb = c;
      return c;
    }
  }
  // Fall back to bare "adb" and let spawn resolve it on PATH (or error clearly).
  cachedAdb = "adb";
  return cachedAdb;
}

export interface ToolStatus {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  hint?: string;
}

async function probe(
  name: string,
  file: string,
  versionArgs: string[],
  hint: string,
): Promise<ToolStatus> {
  const ok = await canRun(file, versionArgs);
  if (!ok) return { name, found: false, hint };
  let version: string | undefined;
  try {
    const r = await exec(file, versionArgs, { timeoutMs: 5_000, allowNonZero: true });
    version = (r.stdout || r.stderr).split("\n")[0]?.trim();
  } catch {
    /* ignore */
  }
  return { name, found: true, path: file, version };
}

export async function checkToolchain(): Promise<ToolStatus[]> {
  const adb = resolveAdb();
  return Promise.all([
    probe(
      "adb",
      adb,
      ["version"],
      "Install Android platform-tools, or set ANDROID_HOME. Required for all Android device control.",
    ),
    probe(
      "xcrun",
      "xcrun",
      ["--version"],
      "Install Xcode command line tools (`xcode-select --install`). Required for iOS simulator control.",
    ),
    probe(
      "idb",
      "idb",
      ["--version"],
      "Install with `brew install idb-companion && pipx install fb-idb`. Enables iOS UI inspection & tap/swipe/type. Without it, iOS UI interaction falls back to Maestro.",
    ),
    probe(
      "maestro",
      "maestro",
      ["--version"],
      "Install from https://maestro.dev. Used under the hood for run_flow, the warm hierarchy engine, and as an iOS interaction fallback.",
    ),
  ]);
}
