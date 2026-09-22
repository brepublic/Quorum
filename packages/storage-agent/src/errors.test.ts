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

it('preserves known operation reasons without interpreting every conflict as a pairing failure', () => {
  expect(agentErrorCode(new AgentApiError(409, 'RESOURCE_CONFLICT', '/private/server', undefined,
    {reason: 'CHAIR_HOST_REVOKED'}))).toBe('CHAIR_HOST_REVOKED');
  expect(agentErrorCode(new AgentApiError(409, 'RESOURCE_CONFLICT', '/private/server', undefined,
    {reason: '/private/server' as never}))).toBe('RESOURCE_CONFLICT');
});
