import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {DEFAULT_COMMITTEE} from '../models/committee';
import {Rank} from './member';
import {CommitteeSetupStatsTable, CommitteeStatsTable, makeCommitteeStats} from './committee-stats';

const committee = {
  ...DEFAULT_COMMITTEE,
  members: {
    china: {name: 'China', present: false, rank: Rank.Veto, voting: false},
    bolivia: {name: 'Bolivia', present: false, rank: Rank.Observer, voting: false},
    france: {name: 'France', present: true, rank: Rank.Standard, voting: false}
  }
};

describe('committee setup statistics', () => {
  it('uses all voting seats for the pre-roll-call summary', () => {
    const stats = makeCommitteeStats(committee);
    const markup = renderToStaticMarkup(<CommitteeSetupStatsTable data={committee} />);
    const container = document.createElement('div');
    container.innerHTML = markup;
    const rowLabels = [...container.querySelectorAll('tbody tr td:first-child')]
      .map(cell => cell.textContent);

    expect(stats.absCanVote).toBe(2);
    expect(stats.canVoteNo).toBe(1);
    expect(rowLabels).toEqual(['Total', 'Have voting rights', 'Quorum']);
    expect(container.textContent).not.toContain('Procedural threshold');
  });

  it('can move attendance and two-thirds majority out of the detail table', () => {
    const markup = renderToStaticMarkup(
      <CommitteeStatsTable
        data={committee}
        verbose={true}
        hiddenRows={['present', 'two-thirds-majority']}
      />
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    const rowLabels = [...container.querySelectorAll('tbody tr td:first-child')]
      .map(cell => cell.textContent);

    expect(rowLabels).not.toContain('Present');
    expect(rowLabels).not.toContain('Two-thirds majority');
    expect(rowLabels).toContain('Procedural threshold');
    expect(rowLabels).toContain('Amendment');
  });
});
