import {describe, it, expect} from 'vitest';
import {agentPairingUrl, parseAgentPairingConfig} from './agent-pairing';
const config = {schemaVersion: 1 as const, kind: 'quorum-agent-pairing' as const, serverUrl: 'https://quorum.example.com',
  committeeId: '10000000-0000-4000-8000-000000000001', committeeName: '安理会 & 大会',
  pairingCode: 'QRM-ABCDE-FGHIJ', purpose: 'INITIAL' as const, expiresAt: '2099-01-01T00:00:00Z'};
describe('portable Agent pairing config', () => {
  it('round-trips Chinese names in an application URL without network query parameters', () => {
    const url = new URL(agentPairingUrl(config));
    expect(url.protocol).toBe('quorum-agent:'); expect(url.search).toBe('');
    expect(parseAgentPairingConfig(JSON.parse(decodeURIComponent(url.hash.slice(1))))).toEqual(config);
  });
  it.each([
    {...config, credential: 'secret'}, {...config, rootPath: '/tmp'}, {...config, serverUrl: 'http://example.com'},
    {...config, serverUrl: 'https://example.com/path'}, {...config, serverUrl: 'https://user:secret@example.com'},
    {...config, committeeId: '../../escape'}, {...config, expiresAt: 'never'}, {...config, schemaVersion: 2}
  ])('rejects unsupported fields, origins and identities', value => {
    expect(() => parseAgentPairingConfig(value)).toThrow('PAIRING_CONFIG_INVALID');
  });
});
