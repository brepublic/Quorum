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

// Only fixed codes cross the desktop boundary; never forward exception messages or server bodies.
export function agentErrorCode(error: unknown, depth = 0): string {
  if (depth > 4) return 'OPERATION_FAILED';
  const value = error as {code?: string; message?: string; cause?: unknown} | undefined;
  const codes = ['AGENT_ALREADY_RUNNING','UNSAFE_AGENT_LOCK','CONFIG_EXISTS','ROOT_ALREADY_PAIRED',
    'CONFIG_PATH_REQUIRED','CONFIG_REQUIRED','STOP_FIRST','ROOT_IDENTITY_MISMATCH','MOVE_COMPLETE_DIRECTORY',
    'SERVER_CERTIFICATE_CHANGED','INVALID_DRAFT','REVOKE_FAILED','CONFIG_PATH_CHANGED','CONFIG_OUTSIDE_ROOT',
    'INVALID_SCAN_INTERVAL','INVALID_CERTIFICATE','PAIRING_FAILED','UNSAFE_PATH','HTTPS_REQUIRED',
    'PAIRING_CODE_REQUIRED','DEVICE_LABEL_REQUIRED','ROOT_REQUIRED','CONFIG_INVALID','CONFIG_PRIVATE_REQUIRED',
    'UNSAVED_CHANGES','LINK_EXPIRED','RESOURCE_CONFLICT','VALIDATION_FAILED','FORBIDDEN','NOT_FOUND',
    'AUTHENTICATION_REQUIRED','STALE_STORAGE_LEASE','SERVICE_NOT_READY','RATE_LIMITED',
    'EEXIST','ENOENT','EACCES','EPERM','ENOSPC','EROFS','ENOTDIR','EISDIR','ECONNREFUSED','ENOTFOUND',
    'ETIMEDOUT','ECONNRESET','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','TLS_TIMEOUT','UND_ERR_CONNECT_TIMEOUT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT',
    'DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID',
    'ERR_TLS_CERT_ALTNAME_INVALID','INVALID_STORAGE_ROOT','UNSAFE_LOCAL_PATH','LOCAL_CONTENT_CONFLICT',
    'LOCAL_CONTENT_INVALID','LOCAL_WRITE_FAILED','HTTP_ERROR'];
  if (value?.cause) {
    const cause = agentErrorCode(value.cause, depth + 1);
    if (cause !== 'OPERATION_FAILED') return cause;
  }
  if (codes.includes(value?.code ?? '')) return value!.code!;
  if (codes.includes(value?.message ?? '')) return value!.message!;
  if (error instanceof SyntaxError) return 'CONFIG_INVALID';
  return 'OPERATION_FAILED';
}
