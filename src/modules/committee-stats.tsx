import * as React from 'react';
import * as Utils from '../utils';
import { canVote, MemberData, MemberID, nonNGO } from './member';
import { Table } from 'semantic-ui-react';
import {CommitteeData} from "../models/committee";
import { t } from '../i18n';

export function makeCommitteeStats(data?: CommitteeData) {
  const defaultMap = {} as Record<MemberID, MemberData>;
  const membersMap: Record<MemberID, MemberData> = data ? (data.members || defaultMap) : defaultMap;
  const members: MemberData[] = Utils.objectToList(membersMap);
  const present = members.filter(x => x.present);

  const delegatesNo: number     = members.length;
  const presentNo: number       = present.length;
  const absCanVote: number      = members.filter(canVote).length;
  const canVoteNo: number       = present.filter(canVote).length;
  const nonNGONo: number        = present.filter(nonNGO).length;

  const simpleMajority: number = Math.ceil(canVoteNo * 0.5);
  const twoThirdsMajority: number = Math.ceil(canVoteNo * (2 / 3));

  const quorum: number          = Math.ceil(absCanVote * 0.25);
  const procedural: number      = Math.ceil(nonNGONo * 0.5);
  const operative: number       = Math.ceil(canVoteNo * 0.5);
  const hasQuorum: boolean      = presentNo >= quorum;
  const draftResolution: number = Math.ceil(canVoteNo * 0.25);
  const amendment: number       = Math.ceil(canVoteNo * 0.1);

  return { delegatesNo, presentNo, absCanVote, canVoteNo, nonNGONo, quorum, 
    procedural, operative, hasQuorum, draftResolution, amendment, twoThirdsMajority, simpleMajority };
}

export type CommitteeStatsRow = 'present' | 'two-thirds-majority';

export function CommitteeStatsTable(props: {
  data?: CommitteeData,
  verbose?: boolean,
  hiddenRows?: CommitteeStatsRow[]
}) {
  const { data, verbose } = props;
  const hiddenRows = new Set(props.hiddenRows || []);

  // TODO: Fill this table out with all fields.
  const  { delegatesNo, presentNo, canVoteNo, quorum, 
    procedural, operative, hasQuorum, draftResolution, amendment, twoThirdsMajority } = makeCommitteeStats(data);

  return (
    <Table definition>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell />
          <Table.HeaderCell>{t('Number')}</Table.HeaderCell>
          <Table.HeaderCell>{t('Description')}</Table.HeaderCell>
          {verbose && <Table.HeaderCell>{t('Threshold')}</Table.HeaderCell>}
        </Table.Row>
      </Table.Header>

      <Table.Body>
        <Table.Row>
          <Table.Cell>{t('Total')}</Table.Cell>
          <Table.Cell>{delegatesNo.toString()}</Table.Cell>
          <Table.Cell>{t('Delegates in committee')}</Table.Cell>
        </Table.Row>
        {!hiddenRows.has('present') && <Table.Row>
          <Table.Cell>{t('Present')}</Table.Cell>
          <Table.Cell>{presentNo.toString()}</Table.Cell>
          <Table.Cell>{t('Delegates in attendance')}</Table.Cell>
        </Table.Row>}
        <Table.Row>
          <Table.Cell>{t('Have voting rights')}</Table.Cell>
          <Table.Cell>{canVoteNo.toString()}</Table.Cell>
          <Table.Cell>{t('Present delegates with voting rights')}</Table.Cell>
        </Table.Row>
        {verbose && <Table.Row>
          <Table.Cell error={!hasQuorum}>{t('Debate')}</Table.Cell>
          <Table.Cell error={!hasQuorum}>{quorum.toString()}</Table.Cell>
          <Table.Cell error={!hasQuorum}>{t('Delegates needed for debate')}</Table.Cell>
          <Table.Cell error={!hasQuorum}>{t('25% of of members with voting rights')}</Table.Cell>
        </Table.Row>}
        {verbose && <Table.Row>
          <Table.Cell>{t('Procedural threshold')}</Table.Cell>
          <Table.Cell>{procedural.toString()}</Table.Cell>
          <Table.Cell>{t('Required votes for procedural matters')}</Table.Cell>
          <Table.Cell>{t('50% of present non-NGO delegates')}</Table.Cell>
        </Table.Row>}
        <Table.Row>
          <Table.Cell>{t('Operative threshold')}</Table.Cell>
          <Table.Cell>{operative.toString()}</Table.Cell>
          <Table.Cell>{t('Required votes for operative matters, such as amendments')}</Table.Cell>
          {verbose && <Table.Cell>{t('50% of present delegates with voting rights')}</Table.Cell>}
        </Table.Row>
        {!hiddenRows.has('two-thirds-majority') && <Table.Row>
          <Table.Cell>{t('Two-thirds majority')}</Table.Cell>
          <Table.Cell>{twoThirdsMajority.toString()}</Table.Cell>
          <Table.Cell>{t('Required votes for passing resolutions')}</Table.Cell>
          {verbose && <Table.Cell>{t('2/3 of present delegates with voting rights')}</Table.Cell>}
        </Table.Row>}
        {verbose && <Table.Row>
          <Table.Cell>{t('Draft resolution')}</Table.Cell>
          <Table.Cell>{draftResolution.toString()}</Table.Cell>
          <Table.Cell>{t('Delegates needed to table a draft resolution')}</Table.Cell>
          <Table.Cell>{t('25% of present delegates with voting rights')}</Table.Cell>
        </Table.Row>}
        {verbose && <Table.Row>
          <Table.Cell>{t('Amendment')}</Table.Cell>
          <Table.Cell>{amendment.toString()}</Table.Cell>
          <Table.Cell>{t('Delegates needed to table an amendment')}</Table.Cell>
          <Table.Cell>{t('10% of present delegates with voting rights')}</Table.Cell>
        </Table.Row>}
      </Table.Body>
    </Table>
  );
}

export function CommitteeSetupStatsTable(props: { data?: CommitteeData }) {
  const { delegatesNo, absCanVote, quorum } = makeCommitteeStats(props.data);

  return (
    <Table definition className="committee-setup-stats">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell />
          <Table.HeaderCell>{t('Number')}</Table.HeaderCell>
          <Table.HeaderCell>{t('Description')}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>

      <Table.Body>
        <Table.Row>
          <Table.Cell>{t('Total')}</Table.Cell>
          <Table.Cell>{delegatesNo.toString()}</Table.Cell>
          <Table.Cell>{t('Delegates in committee')}</Table.Cell>
        </Table.Row>
        <Table.Row>
          <Table.Cell>{t('Have voting rights')}</Table.Cell>
          <Table.Cell>{absCanVote.toString()}</Table.Cell>
          <Table.Cell>{t('Delegates with voting rights')}</Table.Cell>
        </Table.Row>
        <Table.Row>
          <Table.Cell>{t('Quorum')}</Table.Cell>
          <Table.Cell>{quorum.toString()}</Table.Cell>
          <Table.Cell>{t('Delegates needed for debate')}</Table.Cell>
        </Table.Row>
      </Table.Body>
    </Table>
  );
}
