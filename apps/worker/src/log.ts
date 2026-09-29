/**
 * Structured JSON logs: one object per line, so they're greppable locally and parseable by
 * whatever collects them on Render. Every failure path logs the real error with the ids needed
 * to trace it (job, authorization, operation, tx hash).
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const serialize = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/**
 * Values that must never reach a log line or a stored error, even inside an error message. viem
 * puts the RPC URL in its errors, and a hosted RPC URL carries an access token in its path.
 */
function secrets(): string[] {
  return [process.env.ARC_RPC_URL].filter((v): v is string => v !== undefined && v.length > 12);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets()) out = out.replaceAll(secret, "<arc-rpc-url>");
  return out;
}

/** An error's message, safe to store (redacted, and clipped to `max` characters). */
export function errorText(error: unknown, max = 500): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, max);
}

export class Logger {
  constructor(private readonly context: Fields = {}) {}

  with(fields: Fields): Logger {
    return new Logger({ ...this.context, ...fields });
  }

  debug(msg: string, fields?: Fields) {
    if (process.env.LOG_LEVEL === "debug") this.emit("debug", msg, fields);
  }

  info(msg: string, fields?: Fields) {
    this.emit("info", msg, fields);
  }

  warn(msg: string, fields?: Fields) {
    this.emit("warn", msg, fields);
  }

  error(msg: string, error?: unknown, fields?: Fields) {
    const err =
      error instanceof Error
        ? { errorName: error.name, errorMessage: error.message, stack: error.stack }
        : error === undefined
          ? {}
          : { error: String(error) };
    this.emit("error", msg, { ...err, ...fields });
  }

  private emit(level: Level, msg: string, fields: Fields = {}) {
    const line = JSON.stringify(
      { ts: new Date().toISOString(), level, service: "worker", msg, ...this.context, ...fields },
      (_key, value: unknown) => serialize(value),
    );
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(
      `${redact(line)}\n`,
    );
  }
}

export const log = new Logger();
