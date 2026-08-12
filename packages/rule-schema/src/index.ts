export const RULE_SCHEMA_VERSION = 1 as const;

const ROOT_FIELDS = [
  'schemaVersion',
  'key',
  'metadata',
  'meeting',
  'attendance',
  'phases',
  'speakerLists',
  'points',
  'motions',
  'ballots',
  'documents',
  'terminology'
] as const;

const ARRAY_SECTIONS = ['phases', 'speakerLists', 'points', 'motions'] as const;
const OBJECT_SECTIONS = ['meeting', 'attendance', 'ballots', 'documents', 'terminology'] as const;
const EXPRESSION_OPERATORS = new Set([
  'and', 'or', 'not',
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in',
  'add', 'subtract', 'multiply', 'divide',
  'ceil', 'floor', 'min', 'max', 'count', 'sum'
]);
const EFFECT_TYPES = new Set([
  'SET_MEETING_PHASE',
  'CREATE_SPEAKER_LIST',
  'CREATE_CAUCUS',
  'ADD_PROPOSER_AS_FIRST_SPEAKER',
  'START_TIMER',
  'CHANGE_SPEAKER_DURATION',
  'START_BALLOT',
  'SET_DOCUMENT_STATUS',
  'PAUSE_MEETING',
  'RESUME_MEETING',
  'RECALCULATE_THRESHOLDS',
  'NO_STATE_CHANGE'
]);

export interface RulePackageMetadata {
  defaultLanguage: string;
  names: Record<string, string>;
  description?: Record<string, string>;
}

export interface StableRuleItem {
  id: string;
  [key: string]: unknown;
}

export interface RulePackageDefinition {
  schemaVersion: 1;
  key: string;
  metadata: RulePackageMetadata;
  meeting: Record<string, unknown>;
  attendance: Record<string, unknown>;
  phases: StableRuleItem[];
  speakerLists: StableRuleItem[];
  points: StableRuleItem[];
  motions: StableRuleItem[];
  ballots: Record<string, unknown>;
  documents: Record<string, unknown>;
  terminology: Record<string, unknown>;
}

export interface ValidationIssue {
  code: 'INVALID_TYPE' | 'INVALID_VALUE' | 'MISSING_FIELD' | 'UNKNOWN_FIELD' | 'DUPLICATE_ID' | 'INVALID_REFERENCE' | 'EXPRESSION_LIMIT' | 'UNSAFE_EXPRESSION' | 'UNKNOWN_EFFECT';
  path: string;
  message: string;
}

export type RulePackageValidation =
  | {ok: true; value: RulePackageDefinition; issues: []}
  | {ok: false; issues: ValidationIssue[]};

export interface ValidationLimits {
  maxExpressionNodes: number;
  maxExpressionDepth: number;
}

const DEFAULT_LIMITS: ValidationLimits = {
  maxExpressionNodes: 128,
  maxExpressionDepth: 12
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(
  issues: ValidationIssue[],
  code: ValidationIssue['code'],
  path: string,
  message: string
): void {
  issues.push({code, path, message});
}

function validateExpression(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  limits: ValidationLimits,
  state: {nodes: number},
  depth = 0
): void {
  state.nodes += 1;
  if (state.nodes > limits.maxExpressionNodes) {
    issue(issues, 'EXPRESSION_LIMIT', path, 'Expression exceeds the node limit.');
    return;
  }
  if (depth > limits.maxExpressionDepth) {
    issue(issues, 'EXPRESSION_LIMIT', path, 'Expression exceeds the nesting limit.');
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if ('fact' in value) {
    if (typeof value.fact !== 'string' || !/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(value.fact)) {
      issue(issues, 'UNSAFE_EXPRESSION', `${path}.fact`, 'Fact name is not in an allowed namespace form.');
    }
    return;
  }

  if (typeof value.op !== 'string' || !EXPRESSION_OPERATORS.has(value.op)) {
    issue(issues, 'UNSAFE_EXPRESSION', `${path}.op`, 'Expression operator is not allowed.');
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== 'op') {
      validateExpression(child, `${path}.${key}`, issues, limits, state, depth + 1);
    }
  }
}

function inspectNestedValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  limits: ValidationLimits
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => inspectNestedValue(child, `${path}[${index}]`, issues, limits));
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === 'condition' || key === 'formula') {
      validateExpression(child, childPath, issues, limits, {nodes: 0});
    } else if (key === 'effects') {
      if (!Array.isArray(child)) {
        issue(issues, 'INVALID_TYPE', childPath, 'Effects must be an array.');
      } else {
        child.forEach((effect, index) => {
          const effectPath = `${childPath}[${index}]`;
          if (!isRecord(effect) || typeof effect.type !== 'string' || !EFFECT_TYPES.has(effect.type)) {
            issue(issues, 'UNKNOWN_EFFECT', effectPath, 'Effect type is not supported by Quorum.');
          }
        });
      }
    } else {
      inspectNestedValue(child, childPath, issues, limits);
    }
  }
}

export function validateRulePackage(
  input: unknown,
  limits: ValidationLimits = DEFAULT_LIMITS
): RulePackageValidation {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return {ok: false, issues: [{code: 'INVALID_TYPE', path: '$', message: 'Rule package must be an object.'}]};
  }

  const allowedRootFields = new Set<string>(ROOT_FIELDS);
  for (const key of Object.keys(input)) {
    if (!allowedRootFields.has(key)) {
      issue(issues, 'UNKNOWN_FIELD', `$.${key}`, 'Unknown top-level field.');
    }
  }
  for (const key of ROOT_FIELDS) {
    if (!(key in input)) {
      issue(issues, 'MISSING_FIELD', `$.${key}`, 'Required field is missing.');
    }
  }

  if (input.schemaVersion !== RULE_SCHEMA_VERSION) {
    issue(issues, 'INVALID_VALUE', '$.schemaVersion', 'Only rule schema version 1 is supported.');
  }
  if (typeof input.key !== 'string' || !/^[a-z0-9][a-z0-9:._-]{2,127}$/.test(input.key)) {
    issue(issues, 'INVALID_VALUE', '$.key', 'Rule package key is invalid.');
  }

  if (!isRecord(input.metadata)) {
    issue(issues, 'INVALID_TYPE', '$.metadata', 'Metadata must be an object.');
  } else {
    const metadataFields = new Set(['defaultLanguage', 'names', 'description']);
    for (const key of Object.keys(input.metadata)) {
      if (!metadataFields.has(key)) {
        issue(issues, 'UNKNOWN_FIELD', `$.metadata.${key}`, 'Unknown metadata field.');
      }
    }
    const names = input.metadata.names;
    const language = input.metadata.defaultLanguage;
    if (typeof language !== 'string' || language.length < 2) {
      issue(issues, 'INVALID_VALUE', '$.metadata.defaultLanguage', 'Default language is invalid.');
    }
    if (!isRecord(names) || Object.keys(names).length === 0) {
      issue(issues, 'INVALID_TYPE', '$.metadata.names', 'At least one localized name is required.');
    } else if (typeof language === 'string' && typeof names[language] !== 'string') {
      issue(issues, 'INVALID_VALUE', '$.metadata.names', 'Names must include the default language.');
    }
  }

  for (const section of OBJECT_SECTIONS) {
    if (!isRecord(input[section])) {
      issue(issues, 'INVALID_TYPE', `$.${section}`, `${section} must be an object.`);
    }
  }
  const stableIds = new Set<string>();
  for (const section of ARRAY_SECTIONS) {
    const items = input[section];
    if (!Array.isArray(items)) {
      issue(issues, 'INVALID_TYPE', `$.${section}`, `${section} must be an array.`);
      continue;
    }
    items.forEach((item, index) => {
      const itemPath = `$.${section}[${index}]`;
      if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(item.id)) {
        issue(issues, 'INVALID_VALUE', `${itemPath}.id`, 'Stable item ID is invalid.');
        return;
      }
      if (stableIds.has(item.id)) {
        issue(issues, 'DUPLICATE_ID', `${itemPath}.id`, `Duplicate stable ID: ${item.id}`);
      }
      stableIds.add(item.id);
    });
  }

  const referenceFields = new Set(['phaseId', 'speakerListId', 'pointTypeId', 'motionTypeId']);
  const inspectReferences = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => inspectReferences(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (referenceFields.has(key) && (typeof child !== 'string' || !stableIds.has(child))) {
        issue(issues, 'INVALID_REFERENCE', childPath, 'Reference does not identify an item in this package.');
      } else {
        inspectReferences(child, childPath);
      }
    }
  };
  inspectReferences(input, '$');

  inspectNestedValue(input, '$', issues, limits);
  if (issues.length > 0) {
    return {ok: false, issues};
  }
  return {ok: true, value: input as unknown as RulePackageDefinition, issues: []};
}
