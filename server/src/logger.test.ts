// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {createLogger} from './logger';

describe('structured log secret redaction', () => {
  it('redacts identity secrets recursively', () => {
    const lines: string[] = [];
    createLogger(line => lines.push(line)).info('test', {
      password: 'plain-password',
      nested: {sessionToken: 'plain-session', csrfSecret: 'plain-csrf'},
      safe: 'visible'
    });
    const line = lines[0] as string;

    expect(line).not.toContain('plain-password');
    expect(line).not.toContain('plain-session');
    expect(line).not.toContain('plain-csrf');
    expect(JSON.parse(line)).toEqual(expect.objectContaining({password: '[REDACTED]', safe: 'visible'}));
  });
});
