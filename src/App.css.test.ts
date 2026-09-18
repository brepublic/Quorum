import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

describe('current meeting-session card spacing', () => {
  it('offsets both current-session card groups from their divider', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');

    expect(css).toMatch(/\.current-session-divider\.ui\.horizontal\.divider \+ \.motion-queue\.ui\.cards,\s*\.current-session-divider\.ui\.horizontal\.divider \+ \.point-list\.ui\.cards\s*\{\s*margin-top: 0;\s*\}/);
  });
});

describe('resolution voting grid', () => {
  it('uses six growing rows in a column-first layout like roll call', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');

    expect(css).toMatch(/\.resolution-voting-grid\s*\{[^}]*grid-auto-flow:\s*column;[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[^}]*grid-template-rows:\s*repeat\(6, minmax\(3\.25rem, auto\)\);[^}]*\}/s);
  });
});
