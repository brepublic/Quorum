import {currentRequestId} from './request-context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function serializeError(value: unknown): unknown {
  if (!(value instanceof Error)) {
    return value;
  }
  return {
    name: value.name,
    message: value.message,
    stack: value.stack
  };
}

const SECRET_FIELD = /(password|secret|token|cookie|authorization)/i;

function redact(key: string, value: unknown): unknown {
  if (SECRET_FIELD.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact('', item));
  if (value && typeof value === 'object' && !(value instanceof Error)) {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) =>
      [nestedKey, redact(nestedKey, nestedValue)]));
  }
  return serializeError(value);
}

function sanitize(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, redact(key, value)])
  );
}

export function createLogger(sink: LogSink = line => process.stdout.write(`${line}\n`)): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const requestId = currentRequestId();
    sink(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(requestId ? {requestId} : {}),
      ...sanitize(fields)
    }));
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields)
  };
}
