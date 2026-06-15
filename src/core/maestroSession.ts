import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Bounds } from "../drivers/types.js";
import type { RawElement } from "./hierarchy.js";

/**
 * A long-lived `maestro mcp` child process used as a WARM hierarchy/action
 * backend. The first call pays the JVM + device-connect cost (~4s); every call
 * after reuses the connected driver (~150-600ms) — this is what makes us as
 * fast as Maestro MCP on apps whose UI never reaches idle (so adb's
 * `uiautomator dump` can't be used). Falls back to null on any failure so the
 * caller can drop to the cold `maestro` CLI.
 */

function parseBounds(raw: string): Bounds | null {
  const m = raw.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) };
}

interface CompactNode {
  b?: string;
  txt?: string;
  rid?: string;
  a11y?: string;
  hint?: string;
  cls?: string;
  scroll?: boolean;
  clickable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  c?: CompactNode[];
}

/** Expand maestro's compact node format, hoisting bounds-less wrappers. */
function expandCompact(node: CompactNode): RawElement[] {
  const childRaws = (node.c ?? []).flatMap(expandCompact);
  const bounds = parseBounds(node.b ?? "");
  if (!bounds) return childRaws;
  return [
    {
      cls: node.cls || undefined,
      text: (node.txt ?? "").trim() || undefined,
      resourceId: node.rid || undefined,
      accessibility: (node.a11y ?? "").trim() || undefined,
      hint: node.hint || undefined,
      bounds,
      clickable: node.clickable === true,
      enabled: node.enabled !== false,
      focused: node.focused === true,
      selected: node.selected === true,
      checked: node.checked === true,
      scrollable: node.scroll === true,
      children: childRaws,
    },
  ];
}

export interface WarmHierarchy {
  raw: RawElement[];
  width: number;
  height: number;
}

class MaestroSession {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private starting: Promise<Client | null> | null = null;
  private dead = false; // maestro missing or repeatedly failing — stop trying

  private async ensure(): Promise<Client | null> {
    if (this.client) return this.client;
    if (this.dead) return null;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        // Snapshot any pre-existing warm JVMs so we can tell ours apart from a
        // `maestro mcp` server that another Manos process may be running.
        const preexisting = new Set(warmJvmPids());
        const transport = new StdioClientTransport({
          command: "maestro",
          args: ["mcp"],
          stderr: "ignore",
        });
        const client = new Client({ name: "manos-warm", version: "0.1.0" });
        await client.connect(transport);
        this.client = client;
        this.transport = transport;
        // Synchronously kill our warm JVM(s) on exit — an async close() races
        // process.exit() and would orphan them. We hand the cleanup the snapshot
        // of pre-existing JVMs (not a point-in-time capture of "our" pids): it
        // recomputes the signature-matched set at exit and kills everything that
        // appeared during our session. `maestro mcp` spawns a SECOND JVM (the
        // device/simulator backend) shortly after connect() resolves, so a
        // one-shot capture here misses it; recomputing at exit catches both.
        // Signature-tracked because the macOS disclaimer shim reparents the JVMs
        // to launchd, breaking the transport.pid tree (see below).
        registerChildCleanup(() => transport.pid, preexisting);
        return client;
      } catch {
        this.dead = true;
        return null;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** True if a warm session is (or can be) available. */
  async available(): Promise<boolean> {
    return (await this.ensure()) !== null;
  }

  async inspect(deviceId: string): Promise<WarmHierarchy | null> {
    const client = await this.ensure();
    if (!client) return null;
    try {
      const r: any = await client.callTool({
        name: "inspect_screen",
        arguments: { device_id: deviceId },
      });
      if (r.isError) return null;
      const text: string = (r.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      // maestro prefixes a "Maestro Viewer is available…" banner before the JSON.
      const start = text.indexOf("{");
      if (start < 0) return null;
      const json = JSON.parse(text.slice(start));
      const raw: RawElement[] = (json.elements ?? []).flatMap(expandCompact);
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
    } catch {
      return null;
    }
  }

  /** Run an inline flow on the warm session. Returns false on failure/unavailable. */
  async run(deviceId: string, yaml: string): Promise<boolean> {
    const client = await this.ensure();
    if (!client) return false;
    try {
      const r: any = await client.callTool({ name: "run", arguments: { device_id: deviceId, yaml } });
      return r.isError !== true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.transport = null;
    if (c) {
      try {
        await c.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export const maestroSession = new MaestroSession();

/**
 * The java command line of the warm `maestro mcp` server. Stable across maestro
 * versions (the Kotlin entrypoint + the `mcp` subcommand) and specific enough to
 * never match a cold `maestro test` run or the disclaimer/shell wrapper.
 */
const WARM_JVM_SIGNATURE = "maestro.cli.AppKt mcp";

/** PIDs whose full command line matches the warm-JVM signature. */
function warmJvmPids(): number[] {
  try {
    const out = execSync(`pgrep -f '${WARM_JVM_SIGNATURE}'`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // pgrep exits non-zero when nothing matches
  }
}

/**
 * Recursively SIGKILL a pid and all descendants. maestro mcp spawns a child
 * JVM which spawns a `simulator-server` (video encoder for the viewer); killing
 * only the top pid would orphan the grandchild, so we walk the tree (pgrep -P)
 * and kill leaves first. Synchronous so it works in the 'exit' handler.
 */
function killTree(pid: number): void {
  let children: number[] = [];
  try {
    const out = execSync(`pgrep -P ${pid}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    children = out.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    /* no children (pgrep exits non-zero) */
  }
  for (const child of children) killTree(child);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Kill a recorded JVM pid (and its tree) only if it still carries the warm-JVM
 * signature. The signature check guards against the (tiny) window where the pid
 * was recycled for an unrelated process between session end and this handler.
 */
function killWarmJvm(pid: number): void {
  let cmd = "";
  try {
    cmd = execSync(`ps -p ${pid} -o command=`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return; // already gone (ps exits non-zero)
  }
  if (cmd.includes(WARM_JVM_SIGNATURE)) killTree(pid);
}

let cleanupRegistered = false;
function registerChildCleanup(getPid: () => number | null, preexisting: Set<number>): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const kill = () => {
    const pid = getPid();
    if (pid != null) killTree(pid);
    // On macOS the Gatekeeper/"disclaimer" shim double-forks the maestro JVMs,
    // so they reparent to launchd (PID 1) and escape the transport.pid tree
    // above. Recompute the warm-JVM set NOW and kill every signature-matched
    // process that wasn't already running when we started — this catches both
    // the `maestro mcp` server JVM and the device JVM it spawns later, while
    // sparing a warm session owned by another concurrent Manos process.
    for (const jvmPid of warmJvmPids()) {
      if (!preexisting.has(jvmPid)) killWarmJvm(jvmPid);
    }
  };
  // 'exit' runs synchronously — the only handler guaranteed to complete before
  // the process dies, so it's where we must kill the child tree.
  process.on("exit", kill);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      kill();
      process.exit(0);
    });
  }
}
