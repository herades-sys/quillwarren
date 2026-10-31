// The desktop app's log files (%APPDATA%\Delve\logs): main.log (this
// process), server.log (the Delve server's output) and llama-server.log (the
// built-in model runtime, written by the server). Each is moved to .1 when it
// passes 5 MB, so the folder stays small. "Copy logs" in the Help menu puts
// the end of each, with the versions, on the clipboard for the user to paste
// into a message. Pure Node (no Electron), so it is tested on its own.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_FILES = ['main.log', 'server.log', 'llama-server.log'] as const;

export class LogFile {
  private readonly file: string;
  private readonly maxBytes: number;
  private written = 0;

  constructor(file: string, maxBytes = 5_000_000) {
    this.file = file;
    this.maxBytes = maxBytes;
    try {
      this.written = statSync(file).size;
    } catch {
      this.written = 0;
    }
  }

  write(text: string): void {
    try {
      if (this.written + text.length > this.maxBytes) {
        try {
          renameSync(this.file, `${this.file}.1`);
        } catch {
          // nothing to move
        }
        this.written = 0;
      }
      mkdirSync(join(this.file, '..'), { recursive: true });
      appendFileSync(this.file, text);
      this.written += Buffer.byteLength(text);
    } catch {
      // a log must never take the app down
    }
  }

  /** A timestamped line. */
  line(msg: string): void {
    this.write(`${new Date().toISOString()} ${msg}\n`);
  }
}

/** The last `lines` lines of a file (reading at most the last `bytes` of it). */
export function tail(file: string, lines = 300, bytes = 256_000): string {
  try {
    const buf = readFileSync(file);
    const text = buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8');
    return text.split(/\r?\n/).slice(-lines - 1).join('\n').trim();
  } catch {
    return '';
  }
}

/**
 * Never let a secret reach the clipboard or a log file, even if something
 * logged it: the launch secret and the Claude Desktop key (passed in), keys
 * and tokens in headers, URLs and JSON ("key": …), and Anthropic or OpenAI
 * API keys wherever they appear.
 */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[secret]');
  return out
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[secret]')
    .replace(/(x-delve-desktop|authorization|api[-_]?key|\bkey|token|secret)(["'=:\s]+)(bearer\s+)?[A-Za-z0-9._~+/-]{16,}/gi, '$1$2$3[secret]');
}

/** What "Copy logs" puts on the clipboard: versions, then the end of each log. */
export function collectLogs(dir: string, about: Record<string, string>, secrets: readonly (string | null | undefined)[] = [], linesEach = 300): string {
  const head = Object.entries(about)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const parts = [`Delve desktop logs, copied ${new Date().toISOString()}\n${head}`];
  for (const name of LOG_FILES) {
    const f = join(dir, name);
    if (!existsSync(f)) {
      parts.push(`===== ${name}: (none)`);
      continue;
    }
    parts.push(`===== ${name} (last ${linesEach} lines)\n${tail(f, linesEach)}`);
  }
  return redact(parts.join('\n\n'), secrets);
}
