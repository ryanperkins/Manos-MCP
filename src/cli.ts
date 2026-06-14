#!/usr/bin/env node
import { serve, SERVER_INFO } from "./server.js";
import { checkToolchain } from "./util/toolchain.js";
import { DriverRegistry } from "./drivers/registry.js";
import { maestroAvailable } from "./core/maestro.js";
import { ocrEngine } from "./core/ocr.js";
import type { CapabilityMap, SupportLevel } from "./drivers/types.js";

const HELP = `Manos ${SERVER_INFO.version} — MCP server for ad-hoc Android & iOS UI testing

Usage:
  manos serve            Start the MCP server on stdio (default)
  manos doctor           Check toolchain + connected devices + capabilities
  manos devices          List connected devices
  manos --help           Show this help

Add to an MCP client (e.g. Claude Code):
  claude mcp add manos -- manos serve
`;

const LEVEL_ICON: Record<SupportLevel, string> = {
  full: "✅",
  partial: "🟡",
  unavailable: "⛔",
};

async function doctor(): Promise<void> {
  console.log(`Manos ${SERVER_INFO.version} — doctor\n`);

  console.log("Toolchain:");
  const tools = await checkToolchain();
  for (const t of tools) {
    const status = t.found ? `✅ ${t.version ?? "found"}${t.path ? `  (${t.path})` : ""}` : "❌ not found";
    console.log(`  ${t.name.padEnd(8)} ${status}`);
    if (!t.found && t.hint) console.log(`           ↳ ${t.hint}`);
  }
  const engine = await ocrEngine();
  console.log(
    `  ${"ocr".padEnd(8)} ${engine ? `✅ ${engine}` : "❌ none"}`,
  );
  if (!engine) console.log("           ↳ macOS uses Apple Vision (Xcode CLT); else `brew install tesseract`.");

  console.log("\nDevices:");
  const registry = new DriverRegistry();
  const devices = await registry.listAllDevices();
  if (devices.length === 0) {
    console.log("  (none — boot an emulator/simulator and re-run)");
  }
  for (const d of devices) {
    console.log(`  • [${d.platform}] ${d.name} — ${d.id} (${d.state}${d.osVersion ? `, ${d.osVersion}` : ""})`);
    try {
      const caps = await registry.driverFor(d.id).capabilities(d.id);
      console.log(`      ${summarizeCaps(caps)}`);
    } catch (err) {
      console.log(`      (capability probe failed: ${err instanceof Error ? err.message : err})`);
    }
  }

  console.log("");
}

function summarizeCaps(caps: CapabilityMap): string {
  const partial: string[] = [];
  const unavailable: string[] = [];
  for (const [name, info] of Object.entries(caps)) {
    if (info.level === "partial") partial.push(name);
    if (info.level === "unavailable") unavailable.push(name);
  }
  const full = Object.keys(caps).length - partial.length - unavailable.length;
  let s = `${LEVEL_ICON.full} ${full} full`;
  if (partial.length) s += `   ${LEVEL_ICON.partial} partial: ${partial.join(", ")}`;
  if (unavailable.length) s += `   ${LEVEL_ICON.unavailable} unavailable: ${unavailable.join(", ")}`;
  return s;
}

async function devices(): Promise<void> {
  const registry = new DriverRegistry();
  const list = await registry.listAllDevices();
  if (list.length === 0) {
    console.log("No devices found.");
    return;
  }
  for (const d of list) {
    console.log(`${d.id}\t${d.platform}\t${d.state}\t${d.osVersion ?? "?"}\t${d.name}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  switch (cmd) {
    case "serve":
      await serve();
      break;
    case "doctor":
      await doctor();
      break;
    case "devices":
      await devices();
      break;
    case "maestro": {
      // hidden: quick check that the maestro CLI passthrough is reachable
      console.log((await maestroAvailable()) ? "maestro: available" : "maestro: not found");
      break;
    }
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
