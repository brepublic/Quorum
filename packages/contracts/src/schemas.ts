import {AUDIT_ACTION_DEFINITIONS, COMMITTEE_EVENT_DEFINITIONS} from './registry.js';

const requestIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128
} as const;

export const API_SUCCESS_SCHEMA = {
  $id: 'https://quorum.local/schemas/api-success.json',
  type: 'object',
  additionalProperties: false,
  required: ['data', 'meta'],
  properties: {
    data: {},
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId'],
      properties: {requestId: requestIdSchema}
    }
  }
} as const;

export const API_ERROR_SCHEMA = {
  $id: 'https://quorum.local/schemas/api-error.json',
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'requestId'],
      properties: {
        code: {type: 'string', minLength: 1},
        message: {type: 'string', minLength: 1},
        details: {type: 'object'},
        requestId: requestIdSchema
      }
    }
  }
} as const;

export const COMMAND_ENVELOPE_SCHEMA = {
  $id: 'https://quorum.local/schemas/command-envelope.json',
  type: 'object',
  additionalProperties: false,
  required: ['baseRevision', 'payload'],
  properties: {
    baseRevision: {type: 'integer', minimum: 1},
    onBehalfOfSeatId: {type: 'string', minLength: 1},
    ruleDecision: {
      type: 'object',
      additionalProperties: false,
      required: ['evaluationId', 'action', 'reason'],
      properties: {
        evaluationId: {type: 'string', minLength: 1},
        action: {enum: ['PROCEED_ONCE', 'CREATE_FUTURE_VERSION', 'APPLY_TO_CURRENT_PROCESS']},
        reason: {type: ['string', 'null']}
      }
    },
    payload: {type: 'object'}
  }
} as const;

export const COMMITTEE_EVENT_SCHEMA = {
  $id: 'https://quorum.local/schemas/committee-event.json',
  type: 'object',
  additionalProperties: false,
  required: ['committeeId', 'sequence', 'eventType', 'resourceType', 'resourceId', 'resourceRevision', 'audience', 'payload', 'createdAt'],
  properties: {
    committeeId: {type: 'string', minLength: 1},
    sequence: {type: 'integer', minimum: 1},
    eventType: {enum: COMMITTEE_EVENT_DEFINITIONS.map(item => item.name)},
    resourceType: {type: 'string', minLength: 1},
    resourceId: {type: 'string', minLength: 1},
    resourceRevision: {type: 'integer', minimum: 1},
    audience: {enum: ['PUBLIC', 'MEMBER', 'CHAIR']},
    payload: {type: 'object'},
    createdAt: {type: 'string', format: 'date-time'}
  }
} as const;

export const AUDIT_ENTRY_SCHEMA = {
  $id: 'https://quorum.local/schemas/audit-entry.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'requestId', 'effectiveCapabilities', 'action', 'resourceType', 'result', 'createdAt'],
  properties: {
    id: {type: 'string', minLength: 1},
    requestId: requestIdSchema,
    committeeId: {type: 'string', minLength: 1},
    actorUserId: {type: 'string', minLength: 1},
    effectiveCapabilities: {type: 'array', items: {type: 'string'}},
    onBehalfOfSeatId: {type: 'string', minLength: 1},
    action: {enum: [...AUDIT_ACTION_DEFINITIONS]},
    resourceType: {type: 'string', minLength: 1},
    resourceId: {type: 'string', minLength: 1},
    result: {enum: ['SUCCEEDED', 'DENIED', 'FAILED']},
    reason: {type: 'string'},
    createdAt: {type: 'string', format: 'date-time'}
  }
} as const;
