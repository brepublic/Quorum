import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

describe('current meeting-session card spacing', () => {
  it('offsets both current-session card groups from their divider', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');

    expect(css).toMatch(/\.current-session-divider\.ui\.horizontal\.divider \+ \.motion-queue\.ui\.cards,\s*\.current-session-divider\.ui\.horizontal\.divider \+ \.point-list\.ui\.cards\s*\{\s*margin-top: 0;\s*\}/);
  });
});
