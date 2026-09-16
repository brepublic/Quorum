// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {agentErrorCode, AgentApiError, AgentFileSystemError} from './errors';

describe('desktop error redaction', () => {
  it('keeps TLS and filesystem causes wrapped by higher-level operations', () => {
    expect(agentErrorCode(new TypeError('fetch failed', {cause:{code:'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'}})))
      .toBe('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(agentErrorCode(new AgentFileSystemError('INVALID_STORAGE_ROOT','private path', {code:'EACCES'})))
      .toBe('EACCES');
  });
  it('retains a known API error while dropping arbitrary server strings and credentials', () => {
    expect(agentErrorCode(new AgentApiError(400,'LINK_EXPIRED','secret body'))).toBe('LINK_EXPIRED');
    expect(agentErrorCode(new AgentApiError(500,'qsa1.secret','secret body'))).toBe('OPERATION_FAILED');
    expect(agentErrorCode(new Error('private-key-secret'))).toBe('OPERATION_FAILED');
  });
});
