import type {AuditAction, CommitteeEventName, EventAudience} from './registry.js';

export interface RuleDecision {
  evaluationId: string;
  action: 'PROCEED_ONCE' | 'CREATE_FUTURE_VERSION' | 'APPLY_TO_CURRENT_PROCESS';
  reason: string | null;
}

export interface CommandEnvelope<T> {
  baseRevision: number;
  onBehalfOfSeatId?: string;
  ruleDecision?: RuleDecision;
  payload: T;
}

export interface CommitteeEvent<T = Record<string, unknown>> {
  committeeId: string;
  sequence: number;
  eventType: CommitteeEventName;
  resourceType: string;
  resourceId: string;
  resourceRevision: number;
  audience: EventAudience;
  payload: T;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  requestId: string;
  committeeId?: string;
  actorUserId?: string;
  effectiveCapabilities: string[];
  onBehalfOfSeatId?: string;
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  result: 'SUCCEEDED' | 'DENIED' | 'FAILED';
  reason?: string;
  createdAt: string;
}
