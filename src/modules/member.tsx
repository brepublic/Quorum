import {
  COUNTRY_NAME_ALIASES,
  COUNTRY_OPTIONS,
  FlagNames,
  LEGACY_COUNTRY_OPTIONS
} from '../constants';
import {objectToList} from "../utils";
import * as _ from "lodash";
import type {DropdownItemProps} from 'semantic-ui-react';
import { getLanguage, t } from '../i18n';
import * as React from 'react';
import {CountryFlag as CountryFlagData} from '../models/country-template';

export enum Rank {
  Veto = 'Veto',
  Standard = 'Standard',
  NGO = 'NGO',
  Observer = 'Observer'
}

export const canVote = (x: MemberData) => (x.rank === Rank.Veto || x.rank === Rank.Standard);
export const nonNGO = (x: MemberData) => (x.rank !== Rank.NGO);

export type MemberID = string;

export interface MemberData {
  name: string;
  present: boolean;
  rank: Rank;
  voting: boolean;
  /** Snapshot of a custom flag selected from a country template. */
  flag?: CountryFlagData;
}

export interface MemberOption {
  memberID?: MemberID;
  key: string;
  value: string;
  flag: DropdownItemProps['flag'];
  text: string;
  disabled?: boolean;
  description?: DropdownItemProps['description'];
}

const COUNTRY_BY_CODE = new Map(
  [...COUNTRY_OPTIONS, ...LEGACY_COUNTRY_OPTIONS].map(option => [option.value, option])
);
const COUNTRY_BY_NAME = new Map(
  [...COUNTRY_OPTIONS, ...LEGACY_COUNTRY_OPTIONS].map(option => [option.text, option])
);
const COUNTRY_ALIASES_BY_CODE = Object.entries(COUNTRY_NAME_ALIASES)
  .reduce((aliasesByCode, [alias, code]) => {
    const aliases = aliasesByCode.get(code) ?? [];
    aliases.push(alias);
    aliasesByCode.set(code, aliases);
    return aliasesByCode;
  }, new Map<string, string[]>());
const VECTOR_FLAG_URLS = import.meta.glob(
  '../../node_modules/flag-icons/flags/4x3/*.svg',
  {eager: true, query: '?url', import: 'default'}
) as Record<string, string>;

export function nameToCountryOption(name: string): MemberOption | undefined {
  const exactMatch = COUNTRY_BY_NAME.get(name);
  if (exactMatch) {
    return exactMatch;
  }

  const aliasedCode = COUNTRY_NAME_ALIASES[name];
  return aliasedCode ? COUNTRY_BY_CODE.get(aliasedCode) : undefined;
}

export function canonicalCountryName(name: string): string {
  return nameToCountryOption(name)?.text ?? name;
}

export function searchCountryOptions(
  options: DropdownItemProps[],
  query: string
): DropdownItemProps[] {
  const normalizedQuery = _.deburr(query).toLowerCase();

  return options.filter(option => {
    const text = typeof option.text === 'string' ? option.text : '';
    const country = nameToCountryOption(text)
      ?? COUNTRY_BY_CODE.get(String(option.value));
    const aliases = country
      ? COUNTRY_ALIASES_BY_CODE.get(country.value) ?? []
      : [];

    return [text, country?.text ?? '', ...aliases]
      .some(term => _.deburr(term).toLowerCase().includes(normalizedQuery));
  });
}

export function displayMemberName(name: string): string {
  const option = nameToCountryOption(name);

  if (getLanguage() !== 'zh-CN' || !option || typeof Intl.DisplayNames !== 'function') {
    return name;
  }

  try {
    return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(option.value.toUpperCase()) ?? name;
  } catch {
    return name;
  }
}

export function localizedMemberOptions(options: MemberOption[]): MemberOption[] {
  return options.map(option => {
    const {memberID: _memberID, ...dropdownOption} = option;
    return {
      ...dropdownOption,
      flag: React.isValidElement(option.flag)
        ? option.flag
        : <MemberFlag member={option.text} />,
      text: displayMemberName(option.text),
      description: option.disabled ? t('Absent') : option.description
    };
  });
}

export function nameToFlagCode(name: string): FlagNames {
  const option = nameToCountryOption(name);
  if (option) {
    return option.flag as FlagNames;
  }

  // Federated States of Micronesia looks kinda like the UN flag?
  return 'fm';
}

export function FlagDisplay(props: {flag?: CountryFlagData}) {
  if (props.flag?.type === 'image' && props.flag.value) {
    return (
      <span className="country-flag-display">
        <img className="country-flag-display-image" src={props.flag.value} alt="" />
      </span>
    );
  }

  return (
    <span className="country-flag-display country-flag-display-emoji">
      {props.flag?.value || '🏳️'}
    </span>
  );
}

export function VectorCountryFlag(props: {code: string}) {
  const code = props.code === 'an' ? 'un' : props.code;
  const src = VECTOR_FLAG_URLS[`../../node_modules/flag-icons/flags/4x3/${code}.svg`];
  if (!src) {
    return <FlagDisplay />;
  }
  return (
    <span className="country-flag-display country-flag-display-vector">
      <img className="country-flag-display-image" src={src} alt="" />
    </span>
  );
}

export function MemberFlag(props: {member: string | Pick<MemberData, 'name' | 'flag'>}) {
  const member = typeof props.member === 'string' ? {name: props.member} : props.member;
  if (member.flag?.value) {
    return <FlagDisplay flag={member.flag} />;
  }
  return <VectorCountryFlag code={nameToFlagCode(member.name)} />;
}

export function memberByName(
  members: Record<MemberID, MemberData> | undefined,
  name: string
): Pick<MemberData, 'name' | 'flag'> {
  const canonicalName = canonicalCountryName(name);
  return Object.values(members || {}).find(
    member => canonicalCountryName(member.name) === canonicalName
  ) ?? {name};
}

function memberToOption(member: MemberData, memberID?: MemberID): MemberOption {
  return {
    ...nameToMemberOption(member.name),
    ...(memberID ? {memberID} : {}),
    flag: <MemberFlag member={member} />
  };
}

export function membersToOptions(members: Record<MemberID, MemberData> | undefined): MemberOption[] {
  const options = objectToList(members || {})
    .map(member => memberToOption(member));

  return _.sortBy(options, (option: MemberOption) => option.text);
}

export function membersToPresentOptions(members: Record<MemberID, MemberData> | undefined): MemberOption[] {
  const options = objectToList(members || {})
    .filter(x => x.present)
    .map(member => memberToOption(member));

  return _.sortBy(options, (option: MemberOption) => option.text);
}

export function membersToAttendanceOptions(members: Record<MemberID, MemberData> | undefined): MemberOption[] {
  const options = Object.entries(members || {})
    .map(([memberID, member]) => ({
      ...memberToOption(member, memberID),
      disabled: !member.present
    }));

  return _.sortBy(options, (option: MemberOption) => option.text);
}

export function isMemberPresent(
  members: Record<MemberID, MemberData> | undefined,
  name: string | undefined
): boolean {
  if (!name) {
    return false;
  }

  const canonicalName = canonicalCountryName(name);
  return Object.values(members || {}).some(member =>
    canonicalCountryName(member.name) === canonicalName && member.present
  );
}

export function nameToMemberOption(name: string): MemberOption {
  return nameToCountryOption(name)
    ?? {key: name, value: name, flag: 'fm', text: name};
}
