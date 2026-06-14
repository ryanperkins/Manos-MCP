import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout as raw bytes — needed for binary output like screenshots */
  stdoutBuffer: Buffer;
  command: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Data to write to stdin */
  input?: string | Buffer;
  /** Treat a non-zero exit code as success (caller inspects code) */
  allowNonZero?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

/**
 * Run a subprocess, capturing stdout/stderr. Rejects with ExecError on
 * non-zero exit (unless allowNonZero) or timeout. Never uses a shell, so
 * arguments are passed verbatim and need no shell-escaping.
 */
export function exec(
  file: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = 30_000, input, allowNonZero = false, env } = opts;
  const commandLine = `${file} ${args.join(" ")}`;

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: env ? { ...process.env, ...env } : process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new ExecError(`Command timed out after ${timeoutMs}ms: ${commandLine}`, {
          code: null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          stdoutBuffer: Buffer.concat(stdoutChunks),
          command: commandLine,
        }),
      );
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? ` (is "${file}" installed and on PATH?)`
          : "";
      reject(new Error(`Failed to spawn ${commandLine}: ${err.message}${hint}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const result: ExecResult = {
        code,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdoutBuffer,
        command: commandLine,
      };
      if (code !== 0 && !allowNonZero) {
        reject(
          new ExecError(
            `Command failed (exit ${code}): ${commandLine}\n${result.stderr || result.stdout}`.trim(),
            result,
          ),
        );
      } else {
        resolve(result);
      }
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/** True if a binary can be spawned (resolves on PATH or as an absolute path). */
export async function canRun(file: string, versionArgs = ["--version"]): Promise<boolean> {
  try {
    await exec(file, versionArgs, { timeoutMs: 5_000, allowNonZero: true });
    return true;
  } catch {
    return false;
  }
}
