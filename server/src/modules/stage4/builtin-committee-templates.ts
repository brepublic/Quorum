import type {LocalizedNames} from '@quorum/contracts';

export interface BuiltinCommitteeTemplateDefinition {
  key: string;
  names: LocalizedNames;
  members: readonly string[];
  vetoMembers?: readonly string[];
}

const codes = (value: string): readonly string[] => value.split(' ');

export const BUILTIN_COMMITTEE_TEMPLATE_DEFINITIONS: readonly BuiltinCommitteeTemplateDefinition[] = [
  {
    key: 'builtin:african-union', names: {'zh-CN': '非洲联盟', en: 'African Union'},
    members: codes('dz ao bj bw bf bi cm cv cf td km cd cg ci dj eg gq er sz et ga gm gh gn gw ke ls lr ly mg mw ml mr mu ma mz na ne ng rw st sn sc sl so za ss sd tz tg tn ug eh zm zw')
  },
  {
    key: 'builtin:asean', names: {'zh-CN': '东南亚国家联盟', en: 'Association of Southeast Asian Nations'},
    members: codes('bn kh id la my mm ph sg th tl vn')
  },
  {
    key: 'builtin:brics', names: {'zh-CN': '金砖国家', en: 'BRICS'},
    members: codes('br cn eg et in id ir ru sa za ae')
  },
  {
    key: 'builtin:european-union', names: {'zh-CN': '欧洲联盟', en: 'European Union'},
    members: codes('at be bg hr cy cz dk ee fi fr de gr hu ie it lv lt lu mt nl pl pt ro sk si es se')
  },
  {
    key: 'builtin:g20', names: {'zh-CN': '二十国集团', en: 'G20'},
    members: ['organization:african-union', ...codes('ar au br ca cn'), 'organization:european-union',
      ...codes('fr de in id it jp mx ru sa za kr tr gb us')]
  },
  {
    key: 'builtin:nato', names: {'zh-CN': '北大西洋公约组织', en: 'North Atlantic Treaty Organization'},
    members: codes('al be bg ca hr cz dk gb ee fi fr de gr hu is it lv lt lu mk me nl no pl pt ro sk si es se tr us')
  },
  {
    key: 'builtin:un-security-council', names: {'zh-CN': '联合国安全理事会', en: 'UN Security Council'},
    members: codes('bh cn co cd dk fr gr lv lr pk pa ru so gb us'), vetoMembers: codes('cn fr ru gb us')
  }
] as const;

export function builtinCommitteeDefinition(key: string): BuiltinCommitteeTemplateDefinition | undefined {
  return BUILTIN_COMMITTEE_TEMPLATE_DEFINITIONS.find(item => item.key === key);
}
