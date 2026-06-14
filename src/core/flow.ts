/**
 * Minimal Maestro-flow emitter. We don't pull in a YAML dependency — the
 * command shapes are known and controlled, so a small typed emitter is enough
 * and keeps the export output stable and reviewable.
 */

export interface Selector {
  text?: string;
  id?: string;
  index?: number;
}

/** A single Maestro command, as the object that will be serialized to YAML. */
export type MaestroCommand =
  | { launchApp: { appId?: string; clearState?: boolean } }
  | { tapOn: Selector | { point: string } }
  | { longPressOn: Selector | { point: string } }
  | { inputText: string }
  | { eraseText: number }
  | { swipe: { direction: string } | { start: string; end: string } }
  | { scroll: Record<string, never> }
  | { pressKey: string }
  | { back: null }
  | { assertVisible: Selector }
  | { assertNotVisible: Selector }
  | { extendedWaitUntil: { visible?: Selector; notVisible?: Selector; timeout: number } }
  | { openLink: string }
  | { clearState: string | null }
  | { stopApp: string }
  | { setLocation: { latitude: number; longitude: number } }
  | { takeScreenshot: string };

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function emit(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (value === null) return "";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => `${pad}- ${emit(v, indent + 1).trimStart()}`).join("\n");
  }
  // object
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  return entries
    .map(([k, v]) => {
      if (v === null) return `${pad}${k}:`;
      if (typeof v === "object" && !Array.isArray(v)) {
        return `${pad}${k}:\n${emit(v, indent + 1)}`;
      }
      return `${pad}${k}: ${emit(v, indent)}`;
    })
    .join("\n");
}

/** Render one command as a top-level flow list item. */
function emitCommand(cmd: MaestroCommand): string {
  const [key, val] = Object.entries(cmd)[0]!;
  // Commands with a null payload render as a bare string: "- back".
  if (val === null) return `- ${key}`;
  if (typeof val === "string" || typeof val === "number") {
    return `- ${key}: ${typeof val === "string" ? quote(val) : val}`;
  }
  return `- ${key}:\n${emit(val, 2)}`;
}

export function stepsToFlowYaml(appId: string | undefined, commands: MaestroCommand[]): string {
  const header = appId ? `appId: ${appId}` : "appId: REPLACE_WITH_YOUR_APP_ID";
  const body = commands.map(emitCommand).join("\n");
  return `${header}\n---\n${body}\n`;
}
