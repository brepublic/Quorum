export const RULE_SCHEMA_VERSION = 1 as const;

const ROOT_FIELDS = [
  'schemaVersion',
  'key',
  'inherits',
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
const REQUIRED_ROOT_FIELDS = ROOT_FIELDS.filter(field => field !== 'inherits');

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
  inherits?: string[];
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
  code: 'INVALID_TYPE' | 'INVALID_VALUE' | 'MISSING_FIELD' | 'UNKNOWN_FIELD' | 'DUPLICATE_ID' | 'INVALID_REFERENCE' |
    'EXPRESSION_LIMIT' | 'UNSAFE_EXPRESSION' | 'UNKNOWN_EFFECT' | 'UNKNOWN_FACT' | 'TYPE_ERROR' |
    'DIVIDE_BY_ZERO' | 'INHERITANCE_CYCLE';
  path: string;
  message: string;
}

export type RulePackageValidation =
  | {ok: true; value: RulePackageDefinition; issues: []}
  | {ok: false; issues: ValidationIssue[]};

export interface ValidationLimits {
  maxExpressionNodes: number;
  maxExpressionDepth: number;
  maxExecutionSteps: number;
}

const DEFAULT_LIMITS: ValidationLimits = {
  maxExpressionNodes: 128,
  maxExpressionDepth: 12,
  maxExecutionSteps: 512
};

const ALLOWED_FACTS = new Set([
  'meeting.phase', 'meeting.operationMode',
  'attendance.allVotingSeatCount', 'attendance.presentSeatCount',
  'attendance.presentVotingSeatCount', 'attendance.eligibleSeatCount',
  'speakerList.queueLength', 'speakerList.remainingTimeMs',
  'motion.type', 'motion.secondCount',
  'ballot.castCount', 'ballot.eligibleSeatCount',
  'documents.pendingCount', 'actor.capabilities'
]);

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
    } else if (!ALLOWED_FACTS.has(value.fact)) {
      issue(issues, 'UNKNOWN_FACT', `${path}.fact`, 'Fact is not registered for rule evaluation.');
    }
    return;
  }

  if (typeof value.op !== 'string' || !EXPRESSION_OPERATORS.has(value.op)) {
    issue(issues, 'UNSAFE_EXPRESSION', `${path}.op`, 'Expression operator is not allowed.');
    return;
  }

  const operands = Object.entries(value).filter(([key]) => key !== 'op').map(([, child]) => child);
  const numericOperators = new Set(['gt', 'gte', 'lt', 'lte', 'add', 'subtract', 'multiply', 'divide', 'ceil', 'floor', 'min', 'max']);
  if (numericOperators.has(value.op) && operands.some(operand =>
    !isRecord(operand) && typeof operand !== 'number')) {
    issue(issues, 'TYPE_ERROR', path, 'Numeric expression contains a non-numeric literal.');
  }
  if (value.op === 'divide' && (value.right === 0 || operands[1] === 0)) {
    issue(issues, 'DIVIDE_BY_ZERO', path, 'Division by zero is not allowed.');
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
    if (/^(script|javascript|sql|regex|module|command|network|url)$/i.test(key)) {
      issue(issues, 'UNKNOWN_FIELD', childPath, 'Executable or external fields are not allowed.');
      continue;
    }
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
  for (const key of REQUIRED_ROOT_FIELDS) {
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
  if (input.inherits !== undefined && (!Array.isArray(input.inherits)
    || input.inherits.some(item => typeof item !== 'string'))) {
    issue(issues, 'INVALID_TYPE', '$.inherits', 'Inheritance must be an array of package keys.');
  } else if (Array.isArray(input.inherits) && input.inherits.includes(input.key)) {
    issue(issues, 'INVALID_REFERENCE', '$.inherits', 'A rule package cannot inherit from itself.');
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

export function validateRulePackageSet(inputs: readonly unknown[]): RulePackageValidation[] {
  const results = inputs.map(input => validateRulePackage(input));
  const valid = new Map(results.flatMap(result => result.ok ? [[result.value.key, result.value] as const] : []));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      cyclic.add(key);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const parent of valid.get(key)?.inherits ?? []) {
      if (!valid.has(parent)) cyclic.add(key);
      else visit(parent);
      if (cyclic.has(parent)) cyclic.add(key);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of valid.keys()) visit(key);
  return results.map(result => {
    if (!result.ok || !cyclic.has(result.value.key)) return result;
    return {ok: false, issues: [{code: 'INHERITANCE_CYCLE', path: '$.inherits',
      message: 'Rule package inheritance is missing or cyclic.'}]};
  });
}

export interface RuleEvaluationLimits {maxExecutionSteps: number}
export interface RuleSimulation {
  values: Record<string, unknown>;
  plannedEffects: Array<Record<string, unknown>>;
  steps: number;
}

export function evaluateRuleExpression(
  expression: unknown,
  facts: Record<string, unknown>,
  limits: RuleEvaluationLimits = {maxExecutionSteps: DEFAULT_LIMITS.maxExecutionSteps}
): {value: unknown; steps: number} {
  let steps = 0;
  const evaluate = (value: unknown): unknown => {
    steps += 1;
    if (steps > limits.maxExecutionSteps) throw new Error('RULE_EXECUTION_LIMIT');
    if (!isRecord(value)) return value;
    if ('fact' in value) {
      if (typeof value.fact !== 'string' || !ALLOWED_FACTS.has(value.fact) || !(value.fact in facts)) {
        throw new Error('UNKNOWN_RULE_FACT');
      }
      return facts[value.fact];
    }
    const args = Object.entries(value).filter(([key]) => key !== 'op').map(([, child]) => evaluate(child));
    const numbers = (): number[] => args.map(item => {
      if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('RULE_TYPE_ERROR');
      return item;
    });
    switch (value.op) {
      case 'and': return args.every(Boolean);
      case 'or': return args.some(Boolean);
      case 'not': return !args[0];
      case 'eq': return args[0] === args[1];
      case 'ne': return args[0] !== args[1];
      case 'gt': return numbers()[0]! > numbers()[1]!;
      case 'gte': return numbers()[0]! >= numbers()[1]!;
      case 'lt': return numbers()[0]! < numbers()[1]!;
      case 'lte': return numbers()[0]! <= numbers()[1]!;
      case 'in': return Array.isArray(args[1]) && args[1].includes(args[0]);
      case 'add': return numbers().reduce((sum, item) => sum + item, 0);
      case 'subtract': return numbers()[0]! - numbers()[1]!;
      case 'multiply': return numbers().reduce((product, item) => product * item, 1);
      case 'divide': {
        const operands = numbers();
        if (operands[1] === 0) throw new Error('RULE_DIVIDE_BY_ZERO');
        return operands[0]! / operands[1]!;
      }
      case 'ceil': return Math.ceil(numbers()[0]!);
      case 'floor': return Math.floor(numbers()[0]!);
      case 'min': return Math.min(...numbers());
      case 'max': return Math.max(...numbers());
      case 'count': {
        if (!Array.isArray(args[0])) throw new Error('RULE_TYPE_ERROR');
        return args[0].length;
      }
      case 'sum': {
        if (!Array.isArray(args[0])) throw new Error('RULE_TYPE_ERROR');
        return args[0].reduce<number>((sum, item) => {
          if (typeof item !== 'number') throw new Error('RULE_TYPE_ERROR');
          return sum + item;
        }, 0);
      }
      default: throw new Error('UNSAFE_RULE_EXPRESSION');
    }
  };
  return {value: evaluate(expression), steps};
}

export function simulateRulePackage(definition: RulePackageDefinition, facts: Record<string, unknown>,
  limits: RuleEvaluationLimits = {maxExecutionSteps: DEFAULT_LIMITS.maxExecutionSteps}): RuleSimulation {
  const values: Record<string, unknown> = {};
  const plannedEffects: Array<Record<string, unknown>> = [];
  let steps = 0;
  const inspect = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => inspect(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key === 'formula' || key === 'condition') {
        const evaluated = evaluateRuleExpression(child, facts, {maxExecutionSteps: limits.maxExecutionSteps - steps});
        steps += evaluated.steps;
        values[childPath] = evaluated.value;
      } else if (key === 'effects' && Array.isArray(child)) {
        plannedEffects.push(...child.map(effect => structuredClone(effect) as Record<string, unknown>));
      } else inspect(child, childPath);
    }
  };
  inspect(definition, '$');
  return {values, plannedEffects, steps};
}

function valueAtPath(definition: RulePackageDefinition | undefined, path: string): unknown {
  let value: unknown = definition;
  for (const part of path.split('.')) {
    if (!isRecord(value) || !(part in value)) return undefined;
    value = value[part];
  }
  return value;
}

export function resolveRuleValue(input: {
  path: string;
  operationOverride?: unknown;
  committeeVersion?: RulePackageDefinition;
  inheritedVersions?: readonly RulePackageDefinition[];
  productDefault: RulePackageDefinition;
}): unknown {
  if (input.operationOverride !== undefined) return structuredClone(input.operationOverride);
  const committeeValue = valueAtPath(input.committeeVersion, input.path);
  if (committeeValue !== undefined) return structuredClone(committeeValue);
  for (const inherited of input.inheritedVersions ?? []) {
    const inheritedValue = valueAtPath(inherited, input.path);
    if (inheritedValue !== undefined) return structuredClone(inheritedValue);
  }
  const fallback = valueAtPath(input.productDefault, input.path);
  if (fallback === undefined) throw new Error('MISSING_PRODUCT_RULE_DEFAULT');
  return structuredClone(fallback);
}
