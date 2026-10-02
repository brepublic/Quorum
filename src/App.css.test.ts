import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

describe('current meeting-session card spacing', () => {
  it('offsets both current-session card groups from their divider', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');

    expect(css).toMatch(/\.current-session-divider\.ui\.horizontal\.divider \+ \.motion-queue\.ui\.cards,\s*\.current-session-divider\.ui\.horizontal\.divider \+ \.point-list\.ui\.cards\s*\{\s*margin-top: 0;\s*\}/);
  });
});

describe('meeting empty-state spacing', () => {
  it('shares motion-page vertical padding with every meeting empty state', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');

    expect(css).toMatch(/\.motions-page,\s*\.meeting-empty-state\s*\{\s*padding-bottom: 3rem;\s*padding-top: 1rem;\s*\}/);
  });
});

describe('resolution voting grid', () => {
  it('uses six growing rows in a column-first layout like roll call', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');

    expect(css).toMatch(/\.resolution-voting-grid\s*\{[^}]*grid-auto-flow:\s*column;[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[^}]*grid-template-rows:\s*repeat\(6, minmax\(3\.25rem, auto\)\);[^}]*\}/s);
  });
});

describe('compact committee navigation', () => {
  it('ends the compact menu at its final button instead of filling the viewport', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');
    expect(css).toMatch(/\.committee-navigation-desktop:not\(\[data-collapse-level="0"\]\) > \.committee-primary-navigation\.ui\.menu\s*\{\s*width: max-content;\s*max-width: 100%;\s*\}/);
  });

  it('sizes the compact account button for a centered avatar with no horizontal item padding', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');
    expect(css).toMatch(/\.ui\.menu \.dropdown\.item\.account-menu-compact\s*\{\s*width: 2\.5em;\s*min-width: 0;\s*padding-left: 0;\s*padding-right: 0;\s*justify-content: center;\s*\}/);
  });

  it('removes the automatic gap before attendance and uses an icon without text spacing', () => {
    const css = readFileSync(resolve(process.cwd(), 'src', 'App.css'), 'utf8');
    expect(css).toMatch(/\.committee-navigation-desktop:not\(\[data-collapse-level="0"\]\) \.committee-primary-navigation\.ui\.menu > \.right\.menu\s*\{\s*margin-left: 0 !important;\s*\}/);
    expect(css).toMatch(/\.ui\.menu \.dropdown\.item\.account-menu-compact > \.dropdown\.icon\s*\{\s*margin: 0;\s*\}/);
  });
});
