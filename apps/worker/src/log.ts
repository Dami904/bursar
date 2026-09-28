/**
 * Structured JSON logs: one object per line, so they're greppable locally and parseable by
 * whatever collects them on Render. Every failure path logs the real error with the ids needed
 * to trace it (job, authorization, operation, tx hash).
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const serialize = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

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
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  }
}

export const log = new Logger();
