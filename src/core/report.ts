import type { RecordedStep } from "./session.js";

/**
 * Renders a recorded ad-hoc session into a single self-contained HTML file:
 * a step-by-step timeline with embedded screenshots, plus an appendix with the
 * replayable flow, captured network, and recent logs. No external assets — it
 * can be attached to a bug ticket as-is.
 */

export interface ReportInput {
  appId?: string;
  deviceId?: string;
  startedAt?: string;
  steps: RecordedStep[];
  flowYaml: string;
  logs?: string;
  network?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function commandLine(step: RecordedStep): string {
  if (!step.command) return "";
  const [key, val] = Object.entries(step.command)[0]!;
  if (val === null) return key;
  if (typeof val === "string" || typeof val === "number") return `${key}: ${val}`;
  return `${key}: ${JSON.stringify(val)}`;
}

export function buildReportHtml(input: ReportInput): string {
  const { appId, deviceId, startedAt, steps, flowYaml, logs, network } = input;
  const replayable = steps.filter((s) => s.command).length;

  const stepCards = steps
    .map((s) => {
      const cmd = commandLine(s);
      const shot = s.screenshot
        ? `<img class="shot" src="data:image/png;base64,${s.screenshot}" alt="step ${s.index}" loading="lazy" />`
        : `<div class="noshot">no screenshot</div>`;
      const time = s.at.split("T")[1]?.replace("Z", "") ?? s.at;
      return `<div class="step">
        ${shot}
        <div class="meta">
          <div class="num">${s.index}</div>
          <div class="desc">${esc(s.description)}</div>
          <div class="time">${esc(time)}</div>
          ${cmd ? `<code class="cmd">${esc(cmd)}</code>` : `<span class="manual">manual / non-replayable</span>`}
        </div>
      </div>`;
    })
    .join("\n");

  const appendix = (title: string, body: string | undefined, lang = "") =>
    body && body.trim()
      ? `<section><h2>${esc(title)}</h2><pre class="${lang}">${esc(body.trim())}</pre></section>`
      : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Session report${appId ? ` — ${esc(appId)}` : ""}</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --text:#e6e9ef; --muted:#98a2b3; --border:#2a2f3a; --accent:#6ea8fe; --code:#0b0d11; --green:#3ddc97; }
  @media (prefers-color-scheme: light){ :root{ --bg:#f7f8fa; --panel:#fff; --text:#1a1d24; --muted:#5a6472; --border:#e2e6ee; --accent:#2563eb; --code:#f1f3f7; } }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1000px;margin:0 auto;padding:32px 24px 80px}
  h1{font-size:26px;margin:0 0 4px} h2{font-size:18px;margin:36px 0 12px;border-bottom:1px solid var(--border);padding-bottom:6px}
  .summary{color:var(--muted);margin-bottom:8px}
  .summary code{background:var(--code);padding:1px 6px;border-radius:5px}
  .steps{display:flex;flex-direction:column;gap:14px;margin-top:18px}
  .step{display:flex;gap:16px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px}
  .shot{width:150px;height:auto;max-height:320px;border-radius:8px;border:1px solid var(--border);object-fit:contain;background:#000;flex:none}
  .noshot{width:150px;height:120px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;border:1px dashed var(--border);border-radius:8px;flex:none}
  .meta{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}
  .num{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:13px}
  .desc{font-weight:600;font-size:16px} .time{color:var(--muted);font-size:12px;font-family:ui-monospace,monospace}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .cmd{background:var(--code);padding:6px 10px;border-radius:6px;font-size:13px;color:var(--green);align-self:flex-start;white-space:pre-wrap;word-break:break-all}
  .manual{color:var(--muted);font-size:12px;font-style:italic}
  pre{background:var(--code);border:1px solid var(--border);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
</style></head>
<body><div class="wrap">
  <h1>Ad-hoc session report</h1>
  <div class="summary">
    ${appId ? `App <code>${esc(appId)}</code> · ` : ""}${deviceId ? `Device <code>${esc(deviceId)}</code> · ` : ""}
    ${steps.length} step${steps.length === 1 ? "" : "s"} (${replayable} replayable)${startedAt ? ` · started ${esc(startedAt)}` : ""}
  </div>
  <div class="steps">${stepCards || "<p>No steps recorded.</p>"}</div>
  ${appendix("Replayable flow (flow.yaml)", flowYaml, "yaml")}
  ${appendix("Network captured during session", network)}
  ${appendix("Recent logs / crashes", logs)}
</div></body></html>`;
}
