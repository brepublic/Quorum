// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {BUILTIN_COMMITTEE_TEMPLATE_DEFINITIONS, builtinCommitteeDefinition} from './builtin-committee-templates';

describe('built-in committee templates', () => {
  it('restores the seven committee templates from the pre-migration UI with stable keys', () => {
    expect(BUILTIN_COMMITTEE_TEMPLATE_DEFINITIONS.map(template => template.key)).toEqual([
      'builtin:african-union', 'builtin:asean', 'builtin:brics', 'builtin:european-union',
      'builtin:g20', 'builtin:nato', 'builtin:un-security-council'
    ]);
    expect(new Set(BUILTIN_COMMITTEE_TEMPLATE_DEFINITIONS.map(template => template.key)).size).toBe(7);
    expect(builtinCommitteeDefinition('builtin:un-security-council')?.vetoMembers).toEqual(['cn', 'fr', 'ru', 'gb', 'us']);
  });
});
