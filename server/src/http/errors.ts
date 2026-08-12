import {ERROR_HTTP_STATUS, type ApiErrorBody, type ApiErrorCode} from '@quorum/contracts';

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(options: {
    code: ApiErrorCode;
    message: string;
    status?: number;
    details?: Record<string, unknown>;
    expose?: boolean;
    cause?: unknown;
  }) {
    super(options.message, {cause: options.cause});
    this.name = 'AppError';
    this.code = options.code;
    this.status = options.status ?? ERROR_HTTP_STATUS[options.code];
    this.details = options.details;
    this.expose = options.expose ?? this.status < 500;
  }
}

export interface NormalizedError {
  status: number;
  body: ApiErrorBody;
  internalError: unknown;
}

export function normalizeError(error: unknown, requestId: string): NormalizedError {
  const appError = error instanceof AppError
    ? error
    : new AppError({
      code: 'INTERNAL_ERROR',
      message: 'The server could not complete the request.',
      expose: false,
      cause: error
    });

  return {
    status: appError.status,
    body: {
      error: {
        code: appError.code,
        message: appError.expose ? appError.message : 'The server could not complete the request.',
        ...(appError.expose && appError.details ? {details: appError.details} : {}),
        requestId
      }
    },
    internalError: error
  };
}
