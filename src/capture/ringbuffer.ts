/**
 * A bounded ring buffer that keeps only the last `maxLines` lines of text fed to
 * it. Chunks may contain partial lines; line splitting is handled internally so
 * that pushing `"foo"` then `"bar\n"` yields a single line `"foobar"`.
 *
 * Memory is bounded regardless of how chatty the producer is.
 */
export class RingBuffer {
  private readonly maxLines: number;
  /** Completed lines, most recent at the end. Length never exceeds maxLines. */
  private readonly completed: string[] = [];
  /** The current, not-yet-terminated trailing line fragment. */
  private partial = '';
  private dropped = false;

  constructor(maxLines: number) {
    // Guard against nonsensical sizes; at least keep one line of context.
    this.maxLines = maxLines > 0 ? Math.floor(maxLines) : 1;
  }

  push(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    let buf = this.partial + chunk;
    this.partial = '';

    let start = 0;
    while (true) {
      const nl = buf.indexOf('\n', start);
      if (nl === -1) {
        // Remainder is an unterminated line fragment.
        this.partial = buf.slice(start);
        break;
      }
      // Preserve the line content without the trailing newline. Strip a
      // trailing \r so CRLF input does not leave stray carriage returns.
      let line = buf.slice(start, nl);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      this.append(line);
      start = nl + 1;
    }
  }

  private append(line: string): void {
    this.completed.push(line);
    if (this.completed.length > this.maxLines) {
      this.completed.shift();
      this.dropped = true;
    }
  }

  /**
   * Returns the buffered lines, including the current trailing partial line (if
   * any) as a final entry. The total is capped at `maxLines`.
   */
  lines(): string[] {
    if (this.partial.length === 0) {
      return [...this.completed];
    }
    const out = [...this.completed, this.partial];
    if (out.length > this.maxLines) {
      // The partial pushed us over capacity; drop the oldest completed line.
      out.shift();
      this.dropped = true;
    }
    return out;
  }

  text(): string {
    return this.lines().join('\n');
  }

  get truncated(): boolean {
    return this.dropped;
  }

  get lineCount(): number {
    return this.lines().length;
  }
}
