export class AgentFileSystemError extends Error {
  constructor(readonly code: 'INVALID_STORAGE_ROOT' | 'UNSAFE_LOCAL_PATH' | 'LOCAL_CONTENT_CONFLICT'
    | 'LOCAL_CONTENT_INVALID' | 'LOCAL_WRITE_FAILED', message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AgentFileSystemError';
  }
}

export class AgentApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'AgentApiError';
  }
}
