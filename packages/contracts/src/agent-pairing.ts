/** Portable, short-lived pairing input. Never a private device configuration. */
export interface AgentPairingConfig {
  schemaVersion: 1;
  kind: 'quorum-agent-pairing';
  serverUrl: string;
  committeeId: string;
  committeeName: string;
  pairingCode: string;
  purpose: 'INITIAL' | 'TRANSFER';
  expiresAt: string;
}

export function parseAgentPairingConfig(value: unknown): AgentPairingConfig {
  const keys = ['schemaVersion', 'kind', 'serverUrl', 'committeeId', 'committeeName', 'pairingCode', 'purpose', 'expiresAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PAIRING_CONFIG_INVALID');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !keys.includes(key)) || v.schemaVersion !== 1 || v.kind !== 'quorum-agent-pairing'
    || keys.slice(2).some(key => typeof v[key] !== 'string')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v.committeeId))
    || !String(v.committeeName).trim() || String(v.committeeName).length > 300
    || !/^QRM-[A-Za-z0-9-]{8,160}$/.test(String(v.pairingCode))
    || !['INITIAL', 'TRANSFER'].includes(String(v.purpose)) || !Number.isFinite(Date.parse(String(v.expiresAt)))) {
    throw new Error('PAIRING_CONFIG_INVALID');
  }
  let url: URL;
  try {url = new URL(String(v.serverUrl));} catch {throw new Error('PAIRING_CONFIG_INVALID');}
  if (url.protocol !== 'https:' || url.origin !== v.serverUrl || url.username || url.password) {
    throw new Error('PAIRING_CONFIG_INVALID');
  }
  return v as unknown as AgentPairingConfig;
}

export function agentPairingUrl(config: AgentPairingConfig): string {
  return `quorum-agent://pair#${encodeURIComponent(JSON.stringify(parseAgentPairingConfig(config)))}`;
}
