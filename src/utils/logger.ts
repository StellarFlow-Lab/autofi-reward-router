export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
  setLevel(level: LogLevel): void;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.message}`;
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

const SECRET_RE = /S[A-Z2-7]{55}/g;

/** Never let a Stellar secret key reach the logs. */
function redact(line: string): string {
  return line.replace(SECRET_RE, 'S***REDACTED***');
}

export function createLogger(scope = 'autofi', state = { level: LogLevel.INFO }): Logger {
  const write = (level: LogLevel, label: string, msg: string, meta: unknown) => {
    if (state.level > level) return;
    const line = redact(`${new Date().toISOString()} ${label.padEnd(5)} [${scope}] ${msg}${formatMeta(meta)}`);
    (level >= LogLevel.WARN ? console.error : console.log)(line);
  };

  return {
    debug: (msg, meta) => write(LogLevel.DEBUG, 'DEBUG', msg, meta),
    info: (msg, meta) => write(LogLevel.INFO, 'INFO', msg, meta),
    warn: (msg, meta) => write(LogLevel.WARN, 'WARN', msg, meta),
    error: (msg, meta) => write(LogLevel.ERROR, 'ERROR', msg, meta),
    child: (child) => createLogger(`${scope}:${child}`, state),
    setLevel: (level) => {
      state.level = level;
    },
  };
}

export const logger = createLogger();
