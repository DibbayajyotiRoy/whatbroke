/**
 * Tiny promisified subprocess helper used by the git and package-manager
 * collectors.
 *
 * Unlike `child_process.exec`, `run` NEVER rejects on a nonzero exit code (or
 * even on a spawn error such as "command not found"): it always resolves with
 * `{ stdout, stderr, code }`. Callers decide what a nonzero/null code means.
 * This keeps collectors free of try/catch noise around expected failures
 * (e.g. running git outside a repo, or a package manager that isn't installed).
 */
import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null if the process was killed by a signal or failed to spawn. */
  code: number | null;
}

export interface RunOpts {
  cwd?: string;
  /** Kill the child after this many ms (default 10s). */
  timeoutMs?: number;
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
}

export async function run(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  const { cwd, timeoutMs = 10_000, input } = opts;

  return new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Synchronous spawn failure (extremely rare): treat as a failed run.
      finish({ stdout: '', stderr: String(err), code: null });
      return;
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGKILL');
            finish({ stdout, stderr, code: null });
          }, timeoutMs)
        : null;

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err) => {
      // e.g. ENOENT when the command isn't installed.
      finish({ stdout, stderr: stderr || String(err), code: null });
    });

    child.on('close', (code) => {
      finish({ stdout, stderr, code });
    });

    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    } else {
      child.stdin?.end();
    }
  });
}
