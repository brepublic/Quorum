// @vitest-environment node

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {validateRulePackage} from './index';

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
});
