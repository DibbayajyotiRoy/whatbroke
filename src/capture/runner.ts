import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  CaptureResult,
  CommandSpec,
  LogBuffer,
  RunOptions,
} from '../types.js';
import { classifyCrash } from './classify.js';
import { RingBuffer } from './ringbuffer.js';

const DEFAULT_LOG_LINES = 500;

type StreamTag = 'stdout' | 'stderr';

interface CombinedChunk {
  order: number;
  stream: StreamTag;
  text: string;
}

/**
 * Spawn the target command, stream its output through to the parent, capture
 * bounded tails of stdout/stderr, forward signals, optionally enforce a timeout,
 * and classify how the child terminated.
 *
 * Rejects (rather than resolving) only for spawn failures such as a command that
 * does not exist (ENOENT) — that is a whatbroke usage error, not a target crash.
 */
export async function runCommand(
  command: CommandSpec,
  opts?: RunOptions,
): Promise<CaptureResult> {
  const logLines = opts?.logLines ?? DEFAULT_LOG_LINES;
  const env = opts?.env ?? process.env;

  const [cmd, ...args] = command.argv;
  if (cmd === undefined) {
    const err = new Error('runCommand: command.argv is empty') as Error & {
      code?: string;
    };
    err.code = 'EINVAL';
    throw err;
  }

  const stdoutBuf = new RingBuffer(logLines);
  const stderrBuf = new RingBuffer(logLines);
  const combinedBuf = new RingBuffer(logLines);

  // Per-stream UTF-8 decoders so a multi-byte char split across chunks is not
  // mis-flagged as binary.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  let order = 0;
  let noticedBinary = false;

  const child = spawn(cmd, args, {
    cwd: command.cwd,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  return await new Promise<CaptureResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const forwardSignal = (sig: NodeJS.Signals): void => {
      if (!child.killed) {
        try {
          child.kill(sig);
        } catch {
          // Child may already be gone; ignore.
        }
      }
    };

    const onSigint = (): void => forwardSignal('SIGINT');
    const onSigterm = (): void => forwardSignal('SIGTERM');

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const cleanup = (): void => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    };

    const recordCombined = (stream: StreamTag, text: string): void => {
      const chunk: CombinedChunk = { order: order++, stream, text };
      // Tag each line with its stream for interleaved ordering.
      for (const line of text.split('\n')) {
        combinedBuf.push(`[${chunk.stream}] ${line}\n`);
      }
    };

    const handleChunk = (
      data: Buffer,
      decoder: StringDecoder,
      streamBuf: RingBuffer,
      stream: StreamTag,
      passthrough: NodeJS.WriteStream,
    ): void => {
      // Pass the raw bytes straight through so the dev sees exact output,
      // including any binary content.
      passthrough.write(data);

      if (!noticedBinary && looksBinary(data)) {
        noticedBinary = true;
        const marker = '[whatbroke] non-UTF8/binary output detected on ' + stream;
        streamBuf.push(marker + '\n');
        combinedBuf.push(`[${stream}] ${marker}\n`);
      }

      const text = decoder.write(data);
      if (text.length > 0) {
        streamBuf.push(text);
        recordCombined(stream, text);
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      handleChunk(data, stdoutDecoder, stdoutBuf, 'stdout', process.stdout);
    });
    child.stderr?.on('data', (data: Buffer) => {
      handleChunk(data, stderrDecoder, stderrBuf, 'stderr', process.stderr);
    });

    if (opts?.timeoutMs !== undefined && opts.timeoutMs >= 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        forwardSignal('SIGTERM');
      }, opts.timeoutMs);
      // Do not let the timeout keep the event loop alive on its own.
      timeoutHandle.unref?.();
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      // ENOENT (command not found) and similar spawn failures are usage errors,
      // not target crashes — surface them to the caller.
      const wrapped = new Error(
        `Failed to start command "${cmd}": ${err.message}`,
      ) as Error & { code?: string };
      wrapped.code = err.code ?? 'ESPAWN';
      reject(wrapped);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      // Flush any buffered partial multibyte sequences.
      const tailOut = stdoutDecoder.end();
      if (tailOut.length > 0) {
        stdoutBuf.push(tailOut);
        recordCombined('stdout', tailOut);
      }
      const tailErr = stderrDecoder.end();
      if (tailErr.length > 0) {
        stderrBuf.push(tailErr);
        recordCombined('stderr', tailErr);
      }

      // A timeout kill is reported by Node as a signal termination. Even if the
      // process happened to exit on its own race, force a signal classification
      // when we initiated the timeout kill.
      const effectiveSignal: string | null = timedOut
        ? signal ?? 'SIGTERM'
        : signal;
      const effectiveExit: number | null = timedOut ? null : code;

      const logs: LogBuffer = {
        stdoutTail: stdoutBuf.text(),
        stderrTail: stderrBuf.text(),
        combinedTail: combinedBuf.text(),
        truncated:
          stdoutBuf.truncated || stderrBuf.truncated || combinedBuf.truncated,
        bufferLines: logLines,
      };

      const crash = classifyCrash({
        exitCode: effectiveExit,
        signal: effectiveSignal,
        stderrText: stderrBuf.text(),
      });

      resolve({
        exitCode: effectiveExit,
        signal: effectiveSignal,
        crash,
        logs,
      });
    });
  });
}

/**
 * Heuristic: a chunk is treated as binary if it contains a NUL byte or a high
 * proportion of non-text control bytes. UTF-8 multibyte sequences are handled by
 * the streaming decoder, so this only fires on genuinely non-text output.
 */
function looksBinary(data: Buffer): boolean {
  const len = data.length;
  if (len === 0) {
    return false;
  }
  let suspicious = 0;
  const sample = Math.min(len, 8192);
  for (let i = 0; i < sample; i++) {
    const b = data[i];
    if (b === undefined) {
      continue;
    }
    if (b === 0) {
      return true; // NUL is a definitive binary marker.
    }
    // Allow tab(9), LF(10), CR(13). Other C0 control bytes are suspicious.
    if (b < 9 || (b > 13 && b < 32)) {
      suspicious++;
    }
  }
  return suspicious / sample > 0.3;
}
