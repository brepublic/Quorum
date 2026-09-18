import {ERROR_HTTP_STATUS, type ApiErrorBody, type ApiErrorCode, type ApiErrorReason, type ApiErrorParams, type ApiFieldError} from '@quorum/contracts';

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly reason?: ApiErrorReason;
  readonly params?: ApiErrorParams;
  readonly fieldErrors?: ApiFieldError[];
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(options: {
    code: ApiErrorCode;
    message: string;
    reason?: ApiErrorReason;
    params?: ApiErrorParams;
    fieldErrors?: ApiFieldError[];
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
    this.reason = options.reason ?? options.code;
    this.params = options.params;
    this.fieldErrors = options.fieldErrors;
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
        ...(appError.expose && appError.reason ? {reason: appError.reason} : {}),
        ...(appError.expose && appError.params ? {params: appError.params} : {}),
        ...(appError.expose && appError.fieldErrors ? {fieldErrors: appError.fieldErrors} : {}),
        requestId
      }
    },
    internalError: error
  };
}
