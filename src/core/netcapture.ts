import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exec, canRun } from "../util/exec.js";
import { resolveAdb } from "../util/toolchain.js";

/**
 * Network capture for debug apps. Two backends, picked by platform:
 *
 * - Android (Frida + OkHttp hook): many apps ignore the system proxy and pin
 *   certs, so we hook OkHttp inside the (debuggable) process — captures
 *   decrypted, structured exchanges regardless of TLS stack, HTTP/2, proxy
 *   bypass, or pinning.
 * - iOS Simulator (mitmproxy): the sim shares the host network and NSURLSession
 *   respects the system proxy, and `simctl keychain add-root-cert` makes the
 *   mitmproxy CA trusted sim-only. So we set the macOS proxy (no sudo), route
 *   the sim through mitmproxy, and capture — mitmproxy handles HTTP/2 and the
 *   request/response parsing for free.
 *
 * Both backends emit the same JSONL shape, so reading/merging/filtering is
 * shared. See NETWORK.md for the full rationale and the dead ends.
 */

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "frida");
const HOOK_PATH = join(ASSET_DIR, "okhttp-capture.js");
const SIDECAR_PATH = join(ASSET_DIR, "sidecar.py");

type Backend = "frida" | "proxy";

interface CaptureSession {
  deviceId: string;
  backend: Backend;
  appId: string;
  filter: string;
  outFile: string;
  /** Android only: JSON file of mock rules the Frida/OkHttp hook reads live. */
  mockFile?: string;
  proc: ChildProcess;
  stderr: string;
  startedAt: number;
  /** Restores host state (e.g. the macOS proxy) when the capture stops. */
  teardown?: () => Promise<void>;
  /** macOS network service whose proxy was changed (for sync restore on exit). */
  proxyService?: string;
}

/** mitmproxy addon emitting the shared JSONL capture shape (iOS capture path). */
const MITM_ADDON = `import json, os, re, time
OUT = os.environ.get("MANOS_FLOW_FILE", "/tmp/flows.jsonl")
FILT = os.environ.get("MANOS_FILTER", "")
rx = re.compile(FILT) if FILT else None
def body(msg):
    try: c = msg.content  # mitmproxy auto-decompresses (gzip/br/deflate)
    except Exception: c = msg.raw_content
    if not c: return None
    ct = msg.headers.get("content-type", "")
    if any(t in ct for t in ("json", "text", "xml", "javascript", "urlencoded", "graphql")) or not ct:
        try: return c.decode("utf-8", "replace")[:16384]
        except Exception: return None
    return "<%d bytes %s>" % (len(c), ct)
def w(r):
    try:
        with open(OUT, "a") as f: f.write(json.dumps(r) + "\\n")
    except Exception: pass
def request(flow):
    u = flow.request.pretty_url
    if rx and not rx.search(u): return
    w({"k": "req", "ts": time.time(), "method": flow.request.method, "url": u,
       "headers": dict(flow.request.headers), "body": body(flow.request)})
def response(flow):
    u = flow.request.pretty_url
    if rx and not rx.search(u): return
    w({"k": "res", "ts": time.time(), "method": flow.request.method, "url": u, "code": flow.response.status_code,
       "headers": dict(flow.response.headers), "body": body(flow.response)})
`;

interface RawEvent {
  ts: number;
  k?: "req" | "res" | "error";
  kind?: "req" | "res" | "error";
  method?: string;
  url?: string;
  code?: number;
  headers?: Record<string, string>;
  body?: string | null;
  desc?: string;
}

/** One logical request, merging the request event with its response(s). */
export interface CapturedExchange {
  ts: number;
  method?: string;
  url?: string;
  status?: number;
  reqHeaders?: Record<string, string>;
  reqBody?: string | null;
  respHeaders?: Record<string, string>;
  respBody?: string | null;
  /** Number of raw Frida events collapsed into this exchange. */
  count: number;
  error?: string;
}

/** Pick the most human-readable body (OkHttp emits both gzipped + decoded). */
function bestBody(bodies: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const b of bodies) {
    if (!b) continue;
    let printable = 0;
    for (let i = 0; i < b.length; i++) {
      const c = b.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c > 159) printable++;
    }
    const ratio = b.length ? printable / b.length : 0;
    const score = ratio > 0.85 ? 1000 + b.length : ratio;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

/**
 * A response-mocking rule (Android). `url` is a regex matched against the full
 * URL; an optional `method` narrows it. At least one action is required: override
 * `status`/`headers`, replace the `body`, regex-`rewrite` the live body (change a
 * field, keep the rest), or inject latency (`delay_ms`). Keys match the JSON the
 * Frida/OkHttp hook reads, so no translation is needed. (`abort` is accepted by
 * the schema but only honored on the iOS proxy path, which is not on this build.)
 */
export interface MockRule {
  url: string;
  method?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Regex find/replace applied to the live response body (change a field, keep the rest). */
  rewrite?: { find: string; replace: string }[];
  delay_ms?: number;
  abort?: boolean;
}

/** Validate + trim mock rules to the canonical shape. Pure; unit-tested. */
export function normalizeMockRules(rules: MockRule[]): MockRule[] {
  return rules.map((r, i) => {
    if (!r || typeof r.url !== "string" || !r.url) {
      throw new Error(`mock rule ${i}: 'url' (a regex) is required.`);
    }
    try {
      new RegExp(r.url);
    } catch {
      throw new Error(`mock rule ${i}: 'url' is not a valid regex: "${r.url}".`);
    }
    const hasHeaders = !!r.headers && Object.keys(r.headers).length > 0;
    const hasRewrite = Array.isArray(r.rewrite) && r.rewrite.length > 0;
    if (hasRewrite) {
      for (const [j, rw] of r.rewrite!.entries()) {
        if (!rw || typeof rw.find !== "string" || typeof rw.replace !== "string") {
          throw new Error(`mock rule ${i} rewrite[${j}]: 'find' and 'replace' strings are required.`);
        }
        try {
          new RegExp(rw.find);
        } catch {
          throw new Error(`mock rule ${i} rewrite[${j}]: 'find' is not a valid regex: "${rw.find}".`);
        }
      }
    }
    const hasAction =
      r.status !== undefined || r.body !== undefined || hasHeaders || hasRewrite || r.delay_ms !== undefined || r.abort === true;
    if (!hasAction) {
      throw new Error(
        `mock rule ${i} ("${r.url}"): needs at least one action (status, headers, body, rewrite, delay_ms, or abort).`,
      );
    }
    const out: MockRule = { url: r.url };
    if (r.method) out.method = r.method;
    if (r.status !== undefined) out.status = r.status;
    if (hasHeaders) out.headers = r.headers;
    if (r.body !== undefined) out.body = r.body;
    if (hasRewrite) out.rewrite = r.rewrite!.map((rw) => ({ find: rw.find, replace: rw.replace }));
    if (r.delay_ms !== undefined) out.delay_ms = r.delay_ms;
    if (r.abort) out.abort = true;
    return out;
  });
}

export interface FridaStatus {
  pythonFrida: boolean;
  serverRunning: boolean;
  abi?: string;
  hint?: string;
}

class NetCapture {
  private readonly sessions = new Map<string, CaptureSession>();

  private adb(serial: string, args: string[], opts?: { timeoutMs?: number }) {
    return exec(resolveAdb(), ["-s", serial, ...args], { timeoutMs: opts?.timeoutMs ?? 15_000 });
  }

  /** Check that the host `frida` python module and on-device frida-server exist. */
  async status(deviceId: string): Promise<FridaStatus> {
    const pythonFrida = await canRun(process.env.MANOS_PYTHON || "python3", ["-c", "import frida"]);
    let serverRunning = false;
    let abi: string | undefined;
    try {
      abi = (await this.adb(deviceId, ["shell", "getprop", "ro.product.cpu.abi"])).stdout.trim();
      const pid = (
        await this.adb(deviceId, ["shell", "su", "0", "pidof", "frida-server"], { timeoutMs: 8_000 })
      ).stdout.trim();
      serverRunning = pid.length > 0;
    } catch {
      /* device may not be rooted / reachable */
    }
    const hints: string[] = [];
    if (!pythonFrida) hints.push("Install host Frida: `python3 -m pip install --user frida-tools`.");
    if (!serverRunning) {
      hints.push(
        `Start frida-server on the device: download frida-server for ${abi ?? "the device ABI"} ` +
          "(github.com/frida/frida/releases), `adb push` it to /data/local/tmp/frida-server, " +
          "`adb shell su 0 chmod 755 ...`, then `adb shell su 0 /data/local/tmp/frida-server &`.",
      );
    }
    return { pythonFrida, serverRunning, abi, hint: hints.join(" ") || undefined };
  }

  isCapturing(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  async start(
    deviceId: string,
    opts: { platform: "android" | "ios"; appId?: string; filter?: string; spawn?: boolean },
  ): Promise<{ started: boolean; message: string }> {
    if (this.sessions.has(deviceId)) {
      return { started: false, message: "Capture already running for this device. Stop it first." };
    }
    return opts.platform === "ios"
      ? this.startProxy(deviceId, { filter: opts.filter, appId: opts.appId })
      : this.startFrida(deviceId, { appId: opts.appId ?? "", filter: opts.filter, spawn: opts.spawn });
  }

  private async startFrida(
    deviceId: string,
    opts: { appId: string; filter?: string; spawn?: boolean },
  ): Promise<{ started: boolean; message: string }> {
    if (!opts.appId) throw new Error("app_id is required for Android network capture.");
    if (!existsSync(HOOK_PATH) || !existsSync(SIDECAR_PATH)) {
      throw new Error(`Frida assets missing (${ASSET_DIR}).`);
    }
    const status = await this.status(deviceId);
    if (!status.pythonFrida || !status.serverRunning) {
      throw new Error(`Frida not ready. ${status.hint}`);
    }

    const filter = opts.filter ?? "";
    const dir = mkdtempSync(join(tmpdir(), "manos-net-"));
    const outFile = join(dir, "flows.jsonl");
    const mockFile = join(dir, "mocks.json");
    await writeFile(outFile, "");
    await writeFile(mockFile, "[]"); // mock-ready; rules added later via setMocks (hot-reloaded)

    // Resolve the running pid; if absent (or spawn requested), spawn fresh to
    // catch startup traffic.
    let pid = "";
    try {
      pid = (await this.adb(deviceId, ["shell", "pidof", opts.appId])).stdout.trim().split(/\s+/)[0] ?? "";
    } catch {
      /* not running */
    }
    const args = [
      SIDECAR_PATH,
      "--device",
      deviceId,
      "--hook",
      HOOK_PATH,
      "--filter",
      filter,
      "--mocks",
      mockFile,
      "--out",
      outFile,
    ];
    if (pid && !opts.spawn) args.push("--pid", pid);
    else args.push("--spawn", opts.appId);

    // The sidecar needs the `frida` module; MANOS_PYTHON lets the host point at a
    // venv/interpreter that has it (default: python3 on PATH).
    const proc = spawn(process.env.MANOS_PYTHON || "python3", args, { stdio: ["ignore", "ignore", "pipe"] });
    const session: CaptureSession = {
      deviceId,
      backend: "frida",
      appId: opts.appId,
      filter,
      outFile,
      mockFile,
      proc,
      stderr: "",
      startedAt: Date.now(),
    };
    proc.stderr?.on("data", (d: Buffer) => {
      session.stderr += d.toString();
      if (session.stderr.length > 8000) session.stderr = session.stderr.slice(-8000);
    });
    proc.on("exit", () => this.sessions.delete(deviceId));
    this.sessions.set(deviceId, session);
    registerCleanup(this);

    // Give Frida a moment to attach; surface an early failure if it died.
    await new Promise((r) => setTimeout(r, 2500));
    if (proc.exitCode !== null) {
      this.sessions.delete(deviceId);
      throw new Error(`Frida sidecar exited: ${session.stderr.trim() || "unknown error"}`);
    }
    const mode = pid && !opts.spawn ? `attached to running pid ${pid}` : "spawned the app";
    return {
      started: true,
      message:
        `Capturing ${opts.appId} (${mode})` +
        (filter ? `, filtered to /${filter}/` : ", all endpoints") +
        ". Interact with the app, then call network_requests.",
    };
  }

  // --- iOS: mitmproxy + macOS proxy + simctl-trusted CA ---

  private async primaryNetworkService(): Promise<string> {
    try {
      const r = await exec("route", ["-n", "get", "default"], { allowNonZero: true, timeoutMs: 5_000 });
      const dev = r.stdout.match(/interface:\s*(\S+)/)?.[1];
      if (dev) {
        const ports = (await exec("networksetup", ["-listallhardwareports"])).stdout;
        for (const block of ports.split(/\n\n+/)) {
          if (new RegExp(`Device:\\s*${dev}\\b`).test(block)) {
            const name = block.match(/Hardware Port:\s*(.+)/)?.[1]?.trim();
            if (name) return name;
          }
        }
      }
    } catch {
      /* fall through */
    }
    return "Wi-Fi";
  }

  private async ensureMitmCa(): Promise<string> {
    const cert = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
    if (existsSync(cert)) return cert;
    // First run of mitmdump writes the CA; start it briefly then stop.
    const p = spawn("mitmdump", ["-p", "8889"], { stdio: "ignore" });
    for (let i = 0; i < 40 && !existsSync(cert); i++) await new Promise((r) => setTimeout(r, 200));
    try {
      p.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    if (!existsSync(cert)) throw new Error("Could not generate the mitmproxy CA.");
    return cert;
  }

  private async startProxy(
    deviceId: string,
    opts: { filter?: string; appId?: string },
  ): Promise<{ started: boolean; message: string }> {
    if (!(await canRun("mitmdump", ["--version"]))) {
      throw new Error("mitmproxy not found. Install it: `brew install mitmproxy`.");
    }
    const filter = opts.filter ?? "";
    const port = 8899;
    const cert = await this.ensureMitmCa();

    // 1) Trust the mitmproxy CA in the simulator (sim-only, no root).
    await exec("xcrun", ["simctl", "keychain", deviceId, "add-root-cert", cert], { timeoutMs: 15_000 });

    // 2) Point the macOS proxy at mitmproxy (no sudo needed), saving prior state.
    const svc = await this.primaryNetworkService();
    const savedSecure = (await exec("networksetup", ["-getsecurewebproxy", svc])).stdout;
    const savedWeb = (await exec("networksetup", ["-getwebproxy", svc])).stdout;
    const setProxy = async () => {
      await exec("networksetup", ["-setsecurewebproxy", svc, "127.0.0.1", String(port)]);
      await exec("networksetup", ["-setwebproxy", svc, "127.0.0.1", String(port)]);
    };
    const restoreOne = async (kind: "secure" | "web", saved: string) => {
      const flag = kind === "secure" ? "-setsecurewebproxystate" : "-setwebproxystate";
      const setter = kind === "secure" ? "-setsecurewebproxy" : "-setwebproxy";
      const enabled = /Enabled:\s*Yes/i.test(saved);
      const server = saved.match(/Server:\s*(\S+)/)?.[1];
      const sport = saved.match(/Port:\s*(\d+)/)?.[1];
      if (enabled && server && sport) {
        await exec("networksetup", [setter, svc, server, sport]).catch(() => {});
      } else {
        await exec("networksetup", [flag, svc, "off"]).catch(() => {});
      }
    };
    await setProxy();

    // 3) Start mitmdump with the shared-format addon + filter.
    const dir = mkdtempSync(join(tmpdir(), "manos-net-"));
    const outFile = join(dir, "flows.jsonl");
    const addonFile = join(dir, "addon.py");
    await writeFile(outFile, "");
    writeFileSync(addonFile, MITM_ADDON);
    const proc = spawn("mitmdump", ["-p", String(port), "-q", "-s", addonFile], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, MANOS_FLOW_FILE: outFile, MANOS_FILTER: filter },
    });

    const session: CaptureSession = {
      deviceId,
      backend: "proxy",
      appId: opts.appId ?? "",
      filter,
      outFile,
      proc,
      stderr: "",
      startedAt: Date.now(),
      proxyService: svc,
      teardown: async () => {
        await restoreOne("secure", savedSecure);
        await restoreOne("web", savedWeb);
      },
    };
    proc.stderr?.on("data", (d: Buffer) => {
      session.stderr = (session.stderr + d.toString()).slice(-8000);
    });
    proc.on("exit", () => {
      void session.teardown?.();
      this.sessions.delete(deviceId);
    });
    this.sessions.set(deviceId, session);
    registerCleanup(this);

    await new Promise((r) => setTimeout(r, 1500));
    if (proc.exitCode !== null) {
      await session.teardown?.();
      this.sessions.delete(deviceId);
      throw new Error(`mitmdump exited: ${session.stderr.trim() || "unknown error"}`);
    }
    return {
      started: true,
      message:
        `Capturing simulator traffic via mitmproxy (macOS proxy on "${svc}")` +
        (filter ? `, filtered to /${filter}/` : ", all endpoints") +
        ". Interact with the app, then call network_requests. (Host proxy is restored on network_stop.)",
    };
  }

  async requests(
    deviceId: string,
    opts: { filter?: string; sinceTs?: number; limit?: number },
  ): Promise<{ exchanges: CapturedExchange[]; total: number; capturing: boolean }> {
    const session = this.sessions.get(deviceId);
    const outFile = session?.outFile;
    if (!outFile || !existsSync(outFile)) {
      return { exchanges: [], total: 0, capturing: this.isCapturing(deviceId) };
    }
    const raw = await readFile(outFile, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const rx = opts.filter ? new RegExp(opts.filter) : null;

    // Merge raw req/res events into one exchange per (method, url).
    const byKey = new Map<
      string,
      { ts: number; method?: string; url?: string; status?: number; reqHeaders?: Record<string, string>; reqBody?: string | null; respHeaders?: Record<string, string>; respBodies: string[]; count: number }
    >();
    const errors: CapturedExchange[] = [];
    for (const line of lines) {
      let o: RawEvent;
      try {
        o = JSON.parse(line) as RawEvent;
      } catch {
        continue;
      }
      const kind = o.kind ?? o.k;
      if (opts.sinceTs && o.ts <= opts.sinceTs) continue;
      if (kind === "error") {
        errors.push({ ts: o.ts, count: 1, error: o.desc });
        continue;
      }
      if (!o.url || (rx && !rx.test(o.url))) continue;
      const key = `${o.method}\n${o.url}`;
      let ex = byKey.get(key);
      if (!ex) {
        ex = { ts: o.ts, method: o.method, url: o.url, respBodies: [], count: 0 };
        byKey.set(key, ex);
      }
      ex.count++;
      ex.ts = Math.min(ex.ts, o.ts);
      if (kind === "req") {
        ex.reqHeaders = o.headers;
        ex.reqBody = o.body ?? ex.reqBody;
      } else if (kind === "res") {
        ex.status = o.code;
        ex.respHeaders = o.headers ?? ex.respHeaders;
        if (o.body) ex.respBodies.push(o.body);
      }
    }

    let exchanges: CapturedExchange[] = [...byKey.values()].map((ex) => ({
      ts: ex.ts,
      method: ex.method,
      url: ex.url,
      status: ex.status,
      reqHeaders: ex.reqHeaders,
      reqBody: ex.reqBody,
      respHeaders: ex.respHeaders,
      respBody: bestBody(ex.respBodies),
      count: ex.count,
    }));
    exchanges.push(...errors);
    exchanges.sort((a, b) => a.ts - b.ts);
    const total = exchanges.length;
    const limit = opts.limit ?? 100;
    if (exchanges.length > limit) exchanges = exchanges.slice(-limit);
    return { exchanges, total, capturing: this.isCapturing(deviceId) };
  }

  async clear(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (session) await writeFile(session.outFile, "");
  }

  /** Current mock rules for a device (empty if none / no session). */
  async getMocks(deviceId: string): Promise<MockRule[]> {
    const session = this.sessions.get(deviceId);
    if (!session?.mockFile || !existsSync(session.mockFile)) return [];
    try {
      return JSON.parse(await readFile(session.mockFile, "utf8")) as MockRule[];
    } catch {
      return [];
    }
  }

  /**
   * Set (replace) or append mock rules for a device. Android only — mocking rides
   * the Frida/OkHttp capture hook (per-process), so a capture must already be
   * running. Rules hot-reload (the hook re-reads the file); empty + replace clears
   * mocking. (iOS response mocking is in development — capture-only on this build.)
   */
  async setMocks(
    deviceId: string,
    rules: MockRule[],
    opts: { platform: "android" | "ios"; replace?: boolean },
  ): Promise<{ rules: MockRule[]; autoStarted: boolean }> {
    if (opts.platform === "ios") {
      throw new Error(
        "iOS response mocking is in development; only Android is supported in this build. " +
          "iOS network_start still captures traffic.",
      );
    }
    const normalized = normalizeMockRules(rules);
    if (!this.sessions.has(deviceId)) {
      // Android mocking rides the Frida/OkHttp capture hook (per-process, needs
      // app_id + frida-server), so a capture must already be running.
      throw new Error(
        "Start capture first — Android mocking rides the Frida capture hook. " +
          "Call network_start with the app_id (frida-server required), then network_mock.",
      );
    }
    const session = this.sessions.get(deviceId);
    if (!session?.mockFile) throw new Error("No capture session with a mock file is available.");
    const final = opts.replace === false ? [...(await this.getMocks(deviceId)), ...normalized] : normalized;
    await writeFile(session.mockFile, JSON.stringify(final));
    return { rules: final, autoStarted: false };
  }

  async stop(deviceId: string): Promise<{ stopped: boolean }> {
    const session = this.sessions.get(deviceId);
    if (!session) return { stopped: false };
    this.sessions.delete(deviceId);
    try {
      session.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await session.teardown?.();
    return { stopped: true };
  }

  stopAllSync(): void {
    for (const s of this.sessions.values()) {
      try {
        s.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      // Best-effort synchronous host-proxy restore on hard exit (we can't await
      // the async teardown here). Disables the proxy on the affected service.
      if (s.backend === "proxy" && s.proxyService) {
        for (const flag of ["-setsecurewebproxystate", "-setwebproxystate"]) {
          try {
            execFileSync("networksetup", [flag, s.proxyService, "off"], { stdio: "ignore" });
          } catch {
            /* ignore */
          }
        }
      }
    }
    this.sessions.clear();
  }
}

export const netCapture = new NetCapture();

let cleanupRegistered = false;
function registerCleanup(nc: NetCapture): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on("exit", () => nc.stopAllSync());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      nc.stopAllSync();
      process.exit(0);
    });
  }
}
