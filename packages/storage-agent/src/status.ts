import type {AgentDirectoryState} from './state.js';

export interface AgentPublicStatus {
  leaseGeneration: number;
  manifestSequence: number;
  trackedFiles: number;
  pendingUploads: number;
  pendingConflicts: number;
}

export function publicAgentStatus(state: AgentDirectoryState, leaseGeneration: number): AgentPublicStatus {
  return {leaseGeneration, manifestSequence: state.manifestSequence,
    trackedFiles: Object.keys(state.files).length,
    pendingUploads: Object.keys(state.pendingUploads).length,
    pendingConflicts: Object.keys(state.conflicts).length};
}
