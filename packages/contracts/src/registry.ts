export const CONTRACT_VERSION = 1 as const;

export const ERROR_DEFINITIONS = [
  {code: 'BAD_REQUEST', httpStatus: 400},
  {code: 'AUTHENTICATION_REQUIRED', httpStatus: 401},
  {code: 'FORBIDDEN', httpStatus: 403},
  {code: 'NOT_FOUND', httpStatus: 404},
  {code: 'METHOD_NOT_ALLOWED', httpStatus: 405},
  {code: 'REVISION_CONFLICT', httpStatus: 409},
  {code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409},
  {code: 'RESOURCE_CONFLICT', httpStatus: 409},
  {code: 'STALE_STORAGE_LEASE', httpStatus: 409},
  {code: 'CURSOR_EXPIRED', httpStatus: 410},
  {code: 'LINK_EXPIRED', httpStatus: 410},
  {code: 'PAYLOAD_TOO_LARGE', httpStatus: 413},
  {code: 'VALIDATION_FAILED', httpStatus: 422},
  {code: 'CHAIR_DECISION_REQUIRED', httpStatus: 422},
  {code: 'RATE_LIMITED', httpStatus: 429},
  {code: 'INTERNAL_ERROR', httpStatus: 500},
  {code: 'SERVICE_NOT_READY', httpStatus: 503}
] as const;

export type ApiErrorCode = typeof ERROR_DEFINITIONS[number]['code'];

export const ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = Object.freeze(
  Object.fromEntries(ERROR_DEFINITIONS.map(({code, httpStatus}) => [code, httpStatus])) as Record<ApiErrorCode, number>
);

export const COMMITTEE_EVENT_DEFINITIONS = [
  {name: 'committee.updated', defaultAudience: 'MEMBER'},
  {name: 'operation_mode.changed', defaultAudience: 'MEMBER'},
  {name: 'attendance.changed', defaultAudience: 'MEMBER'},
  {name: 'point.raised', defaultAudience: 'MEMBER'},
  {name: 'point.resolved', defaultAudience: 'MEMBER'},
  {name: 'speaker_request.created', defaultAudience: 'CHAIR'},
  {name: 'speaker_queue.changed', defaultAudience: 'MEMBER'},
  {name: 'timer.changed', defaultAudience: 'MEMBER'},
  {name: 'timer.expired', defaultAudience: 'MEMBER'},
  {name: 'motion.proposed', defaultAudience: 'MEMBER'},
  {name: 'motion.decided', defaultAudience: 'MEMBER'},
  {name: 'ballot.opened', defaultAudience: 'MEMBER'},
  {name: 'ballot.vote_recorded', defaultAudience: 'CHAIR'},
  {name: 'ballot.vote_corrected', defaultAudience: 'CHAIR'},
  {name: 'ballot.result_published', defaultAudience: 'PUBLIC'},
  {name: 'file.created', defaultAudience: 'MEMBER'},
  {name: 'file.sync_state_changed', defaultAudience: 'MEMBER'},
  {name: 'file.deleted', defaultAudience: 'MEMBER'},
  {name: 'storage_host.status_changed', defaultAudience: 'CHAIR'},
  {name: 'rule_package.activated', defaultAudience: 'MEMBER'},
  {name: 'committee.archived', defaultAudience: 'MEMBER'}
] as const;

export type EventAudience = 'PUBLIC' | 'MEMBER' | 'CHAIR';
export type CommitteeEventName = typeof COMMITTEE_EVENT_DEFINITIONS[number]['name'];

export const AUDIT_ACTION_DEFINITIONS = [
  'system.bootstrap_admin_created',
  'identity.login_succeeded',
  'identity.login_failed',
  'identity.session_revoked',
  'identity.password_changed',
  'admin.user_created',
  'admin.user_disabled',
  'admin.user_anonymized',
  'committee.created',
  'committee.updated',
  'committee.operation_mode_changed',
  'committee.chair_granted',
  'committee.chair_revoked',
  'committee.archived',
  'committee.deleted',
  'proceedings.chair_acted_on_behalf',
  'rules.package_activated',
  'rules.chair_override_applied',
  'voting.vote_corrected',
  'voting.result_published',
  'storage.binding_changed',
  'storage.host_transferred',
  'storage.file_deleted'
] as const;

export type AuditAction = typeof AUDIT_ACTION_DEFINITIONS[number];
