import { type MaestroCommand, stepsToFlowYaml } from "./flow.js";
import { buildReportHtml } from "./report.js";

export interface RecordedStep {
  index: number;
  at: string; // ISO timestamp
  /** Human-readable one-liner, e.g. 'Tapped "Login"'. */
  description: string;
  /** Structured Maestro command for replay, if this step maps to one. */
  command?: MaestroCommand;
  /** Base64 PNG captured after this step, when report capture is enabled. */
  screenshot?: string;
}

/**
 * Journals the actions taken during an ad-hoc session so it can be promoted
 * into a replayable Maestro flow + a human-readable report. This turns
 * exploratory poking into a regression test with one tool call — the single
 * biggest gap when using Maestro MCP ad hoc.
 */
export class SessionRecorder {
  private recording = false;
  private steps: RecordedStep[] = [];
  private appId: string | undefined;
  private startedAt: string | undefined;
  /** When true, act tools attach a screenshot to each step for the HTML report. */
  private captureScreenshots = false;
  private deviceId: string | undefined;

  get isRecording(): boolean {
    return this.recording;
  }

  get richCapture(): boolean {
    return this.recording && this.captureScreenshots;
  }

  get device(): string | undefined {
    return this.deviceId;
  }

  start(appId?: string, opts?: { captureScreenshots?: boolean }): void {
    this.recording = true;
    this.steps = [];
    this.appId = appId;
    this.startedAt = new Date().toISOString();
    this.captureScreenshots = opts?.captureScreenshots ?? false;
    this.deviceId = undefined;
  }

  stop(): void {
    this.recording = false;
  }

  /** Note the app under test even if recording started before launch. */
  noteApp(appId: string): void {
    if (!this.appId) this.appId = appId;
  }

  noteDevice(deviceId: string): void {
    this.deviceId = deviceId;
  }

  /** Attach a screenshot (base64 PNG) to the most recently recorded step. */
  attachScreenshot(base64: string): void {
    const last = this.steps[this.steps.length - 1];
    if (last) last.screenshot = base64;
  }

  record(description: string, command?: MaestroCommand): void {
    if (!this.recording) return;
    this.steps.push({
      index: this.steps.length + 1,
      at: new Date().toISOString(),
      description,
      command,
    });
  }

  count(): number {
    return this.steps.length;
  }

  getSteps(): RecordedStep[] {
    return [...this.steps];
  }

  exportFlow(): { yaml: string; markdown: string; stepCount: number; appId?: string } {
    const commands = this.steps
      .map((s) => s.command)
      .filter((c): c is MaestroCommand => c !== undefined);
    const yaml = stepsToFlowYaml(this.appId, commands);
    const markdown = this.toMarkdown();
    return { yaml, markdown, stepCount: this.steps.length, appId: this.appId };
  }

  /** Build a self-contained HTML report: step timeline + screenshots + appendix. */
  exportReport(extras: { logs?: string; network?: string }): {
    html: string;
    stepCount: number;
    withScreenshots: number;
  } {
    const { yaml } = this.exportFlow();
    const html = buildReportHtml({
      appId: this.appId,
      deviceId: this.deviceId,
      startedAt: this.startedAt,
      steps: this.steps,
      flowYaml: yaml,
      logs: extras.logs,
      network: extras.network,
    });
    return {
      html,
      stepCount: this.steps.length,
      withScreenshots: this.steps.filter((s) => s.screenshot).length,
    };
  }

  private toMarkdown(): string {
    const lines: string[] = [];
    lines.push(`# Ad-hoc test session`);
    if (this.appId) lines.push(`\n- **App:** \`${this.appId}\``);
    if (this.startedAt) lines.push(`- **Started:** ${this.startedAt}`);
    lines.push(`- **Steps:** ${this.steps.length}\n`);
    lines.push(`## Steps\n`);
    for (const s of this.steps) {
      const replayable = s.command ? "" : " _(manual / non-replayable)_";
      lines.push(`${s.index}. ${s.description}${replayable}`);
    }
    return lines.join("\n") + "\n";
  }
}
