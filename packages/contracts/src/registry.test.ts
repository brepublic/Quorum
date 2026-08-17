// @vitest-environment node

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {
  AUDIT_ACTION_DEFINITIONS,
  COMMITTEE_EVENT_DEFINITIONS,
  ERROR_DEFINITIONS,
  ERROR_HTTP_STATUS
} from './registry';

describe('stable contract registries', () => {
  it('contain no duplicate public names', () => {
    const registries = [
      ERROR_DEFINITIONS.map(item => item.code),
      COMMITTEE_EVENT_DEFINITIONS.map(item => item.name),
      [...AUDIT_ACTION_DEFINITIONS]
    ];

    for (const names of registries) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('maps every error code to its registered HTTP status', () => {
    for (const definition of ERROR_DEFINITIONS) {
      expect(ERROR_HTTP_STATUS[definition.code]).toBe(definition.httpStatus);
    }
  });

  it('keeps example fixtures on registered stable names', async () => {
    const readFixture = async (name: string) => JSON.parse(
      await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    const error = await readFixture('revision-conflict.error.json') as {error: {code: string}};
    const event = await readFixture('ballot-vote-recorded.event.json') as {eventType: string};
    const audit = await readFixture('chair-vote-correction.audit.json') as {action: string};

    expect(ERROR_DEFINITIONS.some(item => item.code === error.error.code)).toBe(true);
    expect(COMMITTEE_EVENT_DEFINITIONS.some(item => item.name === event.eventType)).toBe(true);
    expect(AUDIT_ACTION_DEFINITIONS).toContain(audit.action);
  });
});
