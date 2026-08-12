import {
  canonicalCountryName,
  MemberData,
  MemberID,
  MemberOption,
  membersToAttendanceOptions,
  membersToOptions,
  membersToPresentOptions,
  Rank
} from '../modules/member';
import {logCreateMember} from '../modules/analytics';
import _ from 'lodash';
import {CaucusData, CaucusID, DEFAULT_CAUCUS, GENERAL_SPEAKERS_LIST_ID} from "./caucus";
import { DEFAULT_CAUCUS_TIME_SECONDS } from './constants';
import firebase from "firebase/compat/app";
import {PostData, PostID} from "./post";
import {MotionData, MotionID} from "./motion";
import {DEFAULT_TIMER, TimerData} from "./time";
import {ResolutionData, ResolutionID} from "./resolution";
import {DEFAULT_SETTINGS, SettingsData} from "./settings";
import {StrawpollData, StrawpollID} from "./strawpoll";
import type {CountryTemplateKey} from './country-template';

export function recoverMemberOptions(committee?: CommitteeData): MemberOption[] {
  if (committee) {
    return membersToOptions(committee.members);
  } else {
    return [];
  }
}

export function recoverPresentMemberOptions(committee?: CommitteeData): MemberOption[] {
  if (committee) {
    return membersToPresentOptions(committee.members);
  } else {
    return [];
  }
}

export function recoverAttendanceMemberOptions(committee?: CommitteeData): MemberOption[] {
  if (committee) {
    return membersToAttendanceOptions(committee.members);
  } else {
    return [];
  }
}

export function recoverMembers(committee?: CommitteeData): Record<MemberID, MemberData> | undefined {
  return committee ? (committee.members || {} as Record<MemberID, MemberData>) : undefined;
}

export function recoverSettings(committee?: CommitteeData): Required<SettingsData> {
  let timersInSeparateColumns: boolean =
    committee?.settings.timersInSeparateColumns
    ?? DEFAULT_SETTINGS.timersInSeparateColumns;

  const moveQueueUp: boolean =
    committee?.settings.moveQueueUp
    ?? DEFAULT_SETTINGS.moveQueueUp;

  const autoNextSpeaker: boolean =
    committee?.settings.autoNextSpeaker
    ?? DEFAULT_SETTINGS.autoNextSpeaker;

  const motionVotes: boolean =
    committee?.settings.motionVotes
    ?? DEFAULT_SETTINGS.motionVotes;

  const motionsArePublic: boolean =
    committee?.settings.motionsArePublic
    ?? DEFAULT_SETTINGS.motionsArePublic;

  return {
    timersInSeparateColumns,
    moveQueueUp,
    autoNextSpeaker,
    motionVotes,
    motionsArePublic
  };
}

export function recoverCaucus(committee: CommitteeData | undefined, caucusID: CaucusID): CaucusData | undefined {
  const caucuses = committee ? committee.caucuses : {};

  return (caucuses || {})[caucusID];
}

export function recoverResolution(committee: CommitteeData | undefined, resolutionID: ResolutionID): ResolutionData | undefined {
  const resolutions = committee ? committee.resolutions : {};

  return (resolutions || {})[resolutionID];
}

export type CommitteeID = string;

export enum Template {
  AfricanUnion = 'African Union',
  ASEAN = 'Association of Southeast Asian Nations',
  BRICS = 'BRICS',
  EU = 'European Union',
  G20 = 'G20',
  NATO = 'North Atlantic Treaty Organization',
  SecurityCouncil = 'UN Security Council',
  // TODO: Support these templates against at some point
  // UNHRC = 'UN Human Rights Council',
  // UNICEF = 'UN Children\'s Fund',
  // WHOHealthBoard = 'WHO Health Board',
}

export interface CommitteeData {
  name: string;
  chair: string;
  topic: string;
  conference: string;
  /** Display name of the built-in or user-created template used at creation. */
  template?: string;
  /** Stable key of the committee template used at creation, when one exists. */
  templateKey?: string;
  /** Country template inherited from the committee template or chosen for manual setup. */
  countryTemplateKey?: CountryTemplateKey;
  /** True when this committee was created for manual setup rather than from a saved template. */
  temporaryTemplate?: boolean;
  creatorUid: firebase.UserInfo['uid'];
  members?: Record<MemberID, MemberData>;
  caucuses?: Record<CaucusID, CaucusData>;
  resolutions?: Record<ResolutionID, ResolutionData>;
  strawpolls?: Record<StrawpollID, StrawpollData>;
  motions?: Record<MotionID, MotionData>;
  files?: Record<PostID, PostData>;
  timer: TimerData;
  notes: string;
  settings: SettingsData;
  rollCall?: RollCallData;
}

export interface RollCallData {
  called?: Record<MemberID, true>;
  currentMemberID?: MemberID;
}

const GENERAL_SPEAKERS_LIST: CaucusData = {
  ...DEFAULT_CAUCUS, name: 'General Speakers\' List'
};
export const DEFAULT_COMMITTEE: CommitteeData = {
  name: '',
  chair: '',
  topic: '',
  conference: '',
  creatorUid: '',
  members: {} as Record<MemberID, MemberData>,
  caucuses: {
    [GENERAL_SPEAKERS_LIST_ID]: GENERAL_SPEAKERS_LIST
  } as Record<string, CaucusData>,
  resolutions: {} as Record<ResolutionID, ResolutionData>,
  files: {} as Record<PostID, PostData>,
  strawpolls: {} as Record<StrawpollID, StrawpollData>,
  motions: {} as Record<MotionID, MotionData>,
  timer: {...DEFAULT_TIMER, remaining: DEFAULT_CAUCUS_TIME_SECONDS},
  notes: '',
  settings: DEFAULT_SETTINGS
};
export const putCommittee =
  (committeeID: CommitteeID, committeeData: CommitteeData): firebase.database.Reference => {
    const ref = firebase.database()
      .ref('committees')
      .child(committeeID)

    ref.set(committeeData);

    return ref;
  };

async function deleteStorageTree(ref: firebase.storage.Reference): Promise<void> {
  const contents = await ref.listAll();

  await Promise.all([
    ...contents.items.map(item => item.delete()),
    ...contents.prefixes.map(prefix => deleteStorageTree(prefix))
  ]);
}

/**
 * Permanently deletes a committee's uploaded files and Realtime Database node.
 * Account-level committee and country templates live under separate roots and
 * are intentionally outside this operation.
 */
export async function deleteCommittee(committeeID: CommitteeID): Promise<void> {
  const storageRef = firebase.storage()
    .ref()
    .child('committees')
    .child(committeeID);

  // Remove files first so a failed Storage delete leaves the committee record
  // available for the director to retry instead of orphaning uploaded files.
  await deleteStorageTree(storageRef);
  await firebase.database()
    .ref('committees')
    .child(committeeID)
    .remove();
}

// tslint:disable-next-line
export const putUnmodTimer = (committeeID: CommitteeID, timerData: TimerData): Promise<any> => {
  const ref = firebase.database()
    .ref('committees')
    .child(committeeID)
    .child('timer')
    .set(timerData);

  return ref;
};

// tslint:disable-next-line
const extendTimer = (ref: firebase.database.Reference, seconds: number): Promise<any> => {
  return ref.transaction((timerData: TimerData) => {
    if (timerData) {

      let newRemaining;

      // This is correct, if not a little unclear
      if (timerData.remaining <= 0) {
        newRemaining = seconds;
      } else if (!timerData.ticking) {
        newRemaining = timerData.remaining + seconds;
      } else {
        newRemaining = seconds;
      }

      return {...DEFAULT_TIMER, remaining: newRemaining};

    } else {
      return timerData;
    }
  });
};

// tslint:disable-next-line
export const extendModTimer = (committeeID: CommitteeID, caucusID: CaucusID, seconds: number): Promise<any> => {
  const ref = firebase.database()
    .ref('committees')
    .child(committeeID)
    .child('caucuses')
    .child(caucusID)
    .child('caucusTimer');

  return extendTimer(ref, seconds);
};

// tslint:disable-next-line
export const extendUnmodTimer = (committeeID: CommitteeID, seconds: number): Promise<any> => {
  const ref = firebase.database()
    .ref('committees')
    .child(committeeID)
    .child('timer');

  return extendTimer(ref, seconds);
};

export const pushMember = (committeeID: CommitteeID, member: MemberData) => {
  const ref = firebase.database()
    .ref('committees')
    .child(committeeID);


  ref.child('members').push().set(member);

  logCreateMember(member.name)
}

export type TemplateMember = Pick<MemberData, 'name'> & Partial<Omit<MemberData, 'name'>>;

export const TEMPLATE_TO_MEMBERS: Record<Template, TemplateMember[]> = {
  'African Union': [
    {name: 'Algeria'},
    {name: 'Angola'},
    {name: 'Benin'},
    {name: 'Botswana'},
    {name: 'Burkina Faso'},
    {name: 'Burundi'},
    {name: 'Cameroon'},
    {name: 'Cabo Verde'},
    {name: 'Central African Republic'},
    {name: 'Chad'},
    {name: 'Comoros'},
    {name: 'Democratic Republic of the Congo'},
    {name: 'Republic of the Congo'},
    {name: "Côte d'Ivoire"},
    {name: 'Djibouti'},
    {name: 'Egypt'},
    {name: 'Equatorial Guinea'},
    {name: 'Eritrea'},
    {name: 'Eswatini'},
    {name: 'Ethiopia'},
    {name: 'Gabon'},
    {name: 'Gambia'},
    {name: 'Ghana'},
    {name: 'Guinea'},
    {name: 'Guinea-Bissau'},
    {name: 'Kenya'},
    {name: 'Lesotho'},
    {name: 'Liberia'},
    {name: 'Libya'},
    {name: 'Madagascar'},
    {name: 'Malawi'},
    {name: 'Mali'},
    {name: 'Mauritania'},
    {name: 'Mauritius'},
    {name: 'Morocco'},
    {name: 'Mozambique'},
    {name: 'Namibia'},
    {name: 'Niger'},
    {name: 'Nigeria'},
    {name: 'Rwanda'},
    {name: 'Sao Tome and Principe'},
    {name: 'Senegal'},
    {name: 'Seychelles'},
    {name: 'Sierra Leone'},
    {name: 'Somalia'},
    {name: 'South Africa'},
    {name: 'South Sudan'},
    {name: 'Sudan'},
    {name: 'United Republic of Tanzania'},
    {name: 'Togo'},
    {name: 'Tunisia'},
    {name: 'Uganda'},
    {name: 'Western Sahara'},
    {name: 'Zambia'},
    {name: 'Zimbabwe'}
  ],
  'Association of Southeast Asian Nations': [
    {name: 'Brunei Darussalam'},
    {name: 'Cambodia'},
    {name: 'Indonesia'},
    {name: "Lao People's Democratic Republic"},
    {name: 'Malaysia'},
    {name: 'Myanmar'},
    {name: 'Philippines'},
    {name: 'Singapore'},
    {name: 'Thailand'},
    {name: 'Timor-Leste'},
    {name: 'Viet Nam'}
  ],
  'BRICS': [
    {name: 'Brazil'},
    {name: 'China'},
    {name: 'Egypt'},
    {name: 'Ethiopia'},
    {name: 'India'},
    {name: 'Indonesia'},
    {name: 'Iran (Islamic Republic of)'},
    {name: 'Russian Federation'},
    {name: 'Saudi Arabia'},
    {name: 'South Africa'},
    {name: 'United Arab Emirates'}
  ],
  'European Union': [
    {name: 'Austria'},
    {name: 'Belgium'},
    {name: 'Bulgaria'},
    {name: 'Croatia'},
    {name: 'Cyprus'},
    {name: 'Czechia'},
    {name: 'Denmark'},
    {name: 'Estonia'},
    {name: 'Finland'},
    {name: 'France'},
    {name: 'Germany'},
    {name: 'Greece'},
    {name: 'Hungary'},
    {name: 'Ireland'},
    {name: 'Italy'},
    {name: 'Latvia'},
    {name: 'Lithuania'},
    {name: 'Luxembourg'},
    {name: 'Malta'},
    {name: 'Netherlands'},
    {name: 'Poland'},
    {name: 'Portugal'},
    {name: 'Romania'},
    {name: 'Slovakia'},
    {name: 'Slovenia'},
    {name: 'Spain'},
    {name: 'Sweden'},
  ],
  'G20': [
    {name: 'African Union'},
    {name: 'Argentina'},
    {name: 'Australia'},
    {name: 'Brazil'},
    {name: 'Canada'},
    {name: 'China'},
    {name: 'European Union'},
    {name: 'France'},
    {name: 'Germany'},
    {name: 'India'},
    {name: 'Indonesia'},
    {name: 'Italy'},
    {name: 'Japan'},
    {name: 'Mexico'},
    {name: 'Russian Federation'},
    {name: 'Saudi Arabia'},
    {name: 'South Africa'},
    {name: 'Republic of Korea'},
    {name: 'Türkiye'},
    {name: 'United Kingdom'},
    {name: 'United States of America'},
  ],
  'North Atlantic Treaty Organization': [
    {name: 'Albania'},
    {name: 'Belgium'},
    {name: 'Bulgaria'},
    {name: 'Canada'},
    {name: 'Croatia'},
    {name: 'Czechia'},
    {name: 'Denmark'},
    {name: 'United Kingdom'},
    {name: 'Estonia'},
    {name: 'Finland'}, // since 2023
    {name: 'France'},
    {name: 'Germany'},
    {name: 'Greece'},
    {name: 'Hungary'},
    {name: 'Iceland'},
    {name: 'Italy'},
    {name: 'Latvia'},
    {name: 'Lithuania'},
    {name: 'Luxembourg'},
    {name: 'North Macedonia'},
    {name: 'Montenegro'},
    {name: 'Netherlands'},
    {name: 'Norway'},
    {name: 'Poland'},
    {name: 'Portugal'},
    {name: 'Romania'},
    {name: 'Slovakia'},
    {name: 'Slovenia'},
    {name: 'Spain'},
    {name: 'Sweden'}, // since 2024
    {name: 'Türkiye'},
    {name: 'United States of America'},
  ],
  'UN Security Council': [
    {name: 'Bahrain'},
    {name: 'China', rank: Rank.Veto},
    {name: 'Colombia'},
    {name: 'Democratic Republic of the Congo'},
    {name: 'Denmark'},
    {name: 'France', rank: Rank.Veto},
    {name: 'Greece'},
    {name: 'Latvia'},
    {name: 'Liberia'},
    {name: 'Pakistan'},
    {name: 'Panama'},
    {name: 'Russian Federation', rank: Rank.Veto},
    {name: 'Somalia'},
    {name: 'United Kingdom', rank: Rank.Veto},
    {name: 'United States of America', rank: Rank.Veto},
  ],
}
export const pushTemplateMembers = (committeeID: CommitteeID, template: Template | readonly TemplateMember[]) => {
  const ref = firebase.database()
    .ref('committees')
    .child(committeeID);

  ref.child('members').once('value', (snapshot) => {
    const members: Record<MemberID, MemberData> = snapshot.val() || {};
    const memberIDsByName = new Map(Object.keys(members).map(id => [
      canonicalCountryName(members[id].name),
      id
    ]));

    const templateMembers = typeof template === 'string'
      ? TEMPLATE_TO_MEMBERS[template]
      : template;

    [...templateMembers].forEach(member => {
      const existingID = memberIDsByName.get(canonicalCountryName(member.name));
      if (existingID) {
        // Re-applying a template also repairs or updates custom flag snapshots.
        if (member.flag?.value) {
          ref.child('members').child(existingID).child('flag').set(member.flag);
        }
        return;
      }
      pushMember(committeeID, {
        name: member.name,
        rank: member.rank ?? Rank.Standard,
        present: member.present ?? false,
        voting: member.voting ?? false,
        ...(member.flag?.value ? {flag: member.flag} : {})
      });
    });
  });
}
