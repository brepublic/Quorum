// @vitest-environment node

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {evaluateRuleExpression, resolveRuleValue, simulateRulePackage, validateRulePackage, validateRulePackageSet} from './index';

async function fixture(name: string): Promise<unknown> {
  const contents = await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
  return JSON.parse(contents) as unknown;
}

describe('rule package schema', () => {
  it.each(['quorum-default.v1.json', 'beijing-academic.v1.json'])('validates %s without a server', async name => {
    expect(validateRulePackage(await fixture(name))).toEqual(expect.objectContaining({ok: true}));
  });

  it('rejects unknown top-level fields and duplicate stable IDs', async () => {
    const input = await fixture('quorum-default.v1.json') as Record<string, unknown>;
    input.unsafeScript = 'process.exit()';
    input.phases = [{id: 'formal'}, {id: 'formal'}];

    const result = validateRulePackage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map(item => item.code)).toEqual(expect.arrayContaining(['UNKNOWN_FIELD', 'DUPLICATE_ID']));
    }
  });

  it('rejects executable expression operators and unknown effects', async () => {
    const input = await fixture('quorum-default.v1.json') as Record<string, unknown>;
    input.meeting = {
      condition: {op: 'eval', source: 'process.exit()'},
      effects: [{type: 'RUN_SHELL'}]
    };

    const result = validateRulePackage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map(item => item.code)).toEqual(expect.arrayContaining(['UNSAFE_EXPRESSION', 'UNKNOWN_EFFECT']));
    }
  });

  it('rejects references to stable IDs that are not in the package', async () => {
    const input = await fixture('quorum-default.v1.json') as Record<string, unknown>;
    input.meeting = {speakerListId: 'missing-list'};

    const result = validateRulePackage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map(item => item.code)).toContain('INVALID_REFERENCE');
    }
  });

  it('rejects unknown facts, type errors, division by zero, and cyclic inheritance', async () => {
    const first = await fixture('quorum-default.v1.json') as Record<string, unknown>;
    first.key = 'test:first';
    first.inherits = ['test:second'];
    first.meeting = {unknown: {formula: {op: 'add', left: {fact: 'system.secret'}, right: 'one'}},
      zero: {formula: {op: 'divide', left: 1, right: 0}}};
    const direct = validateRulePackage(first);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.issues.map(item => item.code)).toEqual(expect.arrayContaining([
      'UNKNOWN_FACT', 'TYPE_ERROR', 'DIVIDE_BY_ZERO'
    ]));
    const cycleFirst = await fixture('quorum-default.v1.json') as Record<string, unknown>;
    cycleFirst.key = 'test:first'; cycleFirst.inherits = ['test:second'];
    const cycleSecond = structuredClone(cycleFirst);
    cycleSecond.key = 'test:second'; cycleSecond.inherits = ['test:first'];
    expect(validateRulePackageSet([cycleFirst, cycleSecond]).flatMap(result => result.ok ? [] : result.issues)
      .map(item => item.code)).toContain('INHERITANCE_CYCLE');
  });

  it('evaluates thresholds without state writes and enforces execution steps', async () => {
    const definition = await fixture('quorum-default.v1.json');
    const validated = validateRulePackage(definition);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const simulation = simulateRulePackage(validated.value, {
      'attendance.allVotingSeatCount': 20,
      'attendance.presentVotingSeatCount': 15
    });
    expect(simulation.values['$.attendance.quorum.formula']).toBe(5);
    expect(simulation.values['$.attendance.twoThirdsMajority.formula']).toBe(11);
    expect(simulation.plannedEffects).toEqual(expect.arrayContaining([expect.objectContaining({type: 'START_BALLOT'})]));
    expect(() => evaluateRuleExpression({op: 'add', left: 1, right: 2}, {}, {maxExecutionSteps: 1}))
      .toThrow('RULE_EXECUTION_LIMIT');
    expect(() => evaluateRuleExpression({op: 'divide', left: 1, right: 0}, {})).toThrow('RULE_DIVIDE_BY_ZERO');
  });

  it('enforces expression node and nesting limits during import validation', async () => {
    const definition = await fixture('quorum-default.v1.json') as Record<string, unknown>;
    definition.meeting = {condition: {op: 'not', value: {op: 'not', value: {op: 'eq', left: 1, right: 1}}}};
    const result = validateRulePackage(definition, {maxExpressionNodes: 3, maxExpressionDepth: 1, maxExecutionSteps: 10});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map(item => item.code)).toContain('EXPRESSION_LIMIT');
  });

  it('resolves operation, committee, inherited package, and product values in strict order', async () => {
    const product = await fixture('quorum-default.v1.json') as never;
    const inherited = structuredClone(product) as unknown as {ballots: Record<string, unknown>};
    inherited.ballots.delegateMayChangeVote = true;
    const committee = structuredClone(product) as unknown as {ballots: Record<string, unknown>};
    committee.ballots.delegateMayChangeVote = false;
    expect(resolveRuleValue({path: 'ballots.delegateMayChangeVote', operationOverride: true,
      committeeVersion: committee as never, inheritedVersions: [inherited as never], productDefault: product})).toBe(true);
    expect(resolveRuleValue({path: 'ballots.delegateMayChangeVote', committeeVersion: committee as never,
      inheritedVersions: [inherited as never], productDefault: product})).toBe(false);
    delete committee.ballots.delegateMayChangeVote;
    expect(resolveRuleValue({path: 'ballots.delegateMayChangeVote', committeeVersion: committee as never,
      inheritedVersions: [inherited as never], productDefault: product})).toBe(true);
    delete inherited.ballots.delegateMayChangeVote;
    expect(resolveRuleValue({path: 'ballots.delegateMayChangeVote', committeeVersion: committee as never,
      inheritedVersions: [inherited as never], productDefault: product})).toBe(false);
  });
});
