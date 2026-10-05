import {agentPairingUrl, type AgentPairingConfig} from '@quorum/contracts';

export function openChairAgent(configuration: AgentPairingConfig) {
  window.location.assign(agentPairingUrl(configuration));
}
export function downloadChairConfiguration(configuration: AgentPairingConfig) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(configuration, null, 2) + '\n'], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${configuration.committeeName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}.quorum-agent`;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
