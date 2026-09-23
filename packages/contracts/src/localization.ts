import type {CommitteeTemplate, CommitteeTemplateMember, CountryTemplate, LocalizedNames} from './stage4.js';

export const CONTENT_LANGUAGES = ['zh-CN', 'en'] as const;
export type ContentLanguage = typeof CONTENT_LANGUAGES[number];
export function isContentLanguage(value: unknown): value is ContentLanguage {
  return value === 'zh-CN' || value === 'en';
}

/** Owned by one committee; source IDs and revisions are provenance only. */
export interface CommitteeContentSnapshot {
  schemaVersion: 1;
  countryTemplate: CountryTemplate;
  committeeTemplate: CommitteeTemplate | null;
  initialRulePackageVersionId: string;
}

export interface MissingContentTranslation {
  language: ContentLanguage;
  path: string;
}
export interface ContentLanguageAvailability {
  supportedLanguages: ContentLanguage[];
  missing: MissingContentTranslation[];
}

/** Use every actual name, including custom organizations, not declared languages or flags. */
export function templateLanguageAvailability(
  countryTemplate: Pick<CountryTemplate, 'countries'>,
  members: ReadonlyArray<Pick<CommitteeTemplateMember, 'names'>> = []
): ContentLanguageAvailability {
  const missing: MissingContentTranslation[] = [];
  for (const language of CONTENT_LANGUAGES) {
    for (const [index, country] of countryTemplate.countries.entries()) {
      if (!country.names[language]?.trim()) missing.push({language, path: `countries.${index}.names.${language}`});
    }
    for (const [index, member] of members.entries()) {
      if (!member.names[language]?.trim()) missing.push({language, path: `members.${index}.names.${language}`});
    }
  }
  return {supportedLanguages: CONTENT_LANGUAGES.filter(language => !missing.some(item => item.language === language)), missing};
}

export function intersectContentLanguages(...sources: ReadonlyArray<readonly ContentLanguage[]>): ContentLanguage[] {
  return CONTENT_LANGUAGES.filter(language => sources.every(source => source.includes(language)));
}

/** Missing committee content is a configuration error, never an implicit language fallback. */
export function committeeContentName(names: LocalizedNames, language: ContentLanguage): string {
  const value = names[language];
  if (!value?.trim()) throw new Error(`Missing committee translation: ${language}`);
  return value;
}

/** Only motion labels allow the interface-language -> committee-language fallback. */
export function motionContentName(names: LocalizedNames, interfaceLanguage: ContentLanguage,
  committeeLanguage: ContentLanguage): string {
  return names[interfaceLanguage]?.trim() ? names[interfaceLanguage]! : committeeContentName(names, committeeLanguage);
}

export function delegateFileTypeName(type: import('./delegate-files.js').DelegateFileType, language: ContentLanguage): string {
  const names = {WORKING_PAPER: {en: 'Working Paper', 'zh-CN': '工作文件'},
    DIRECTIVE_DRAFT: {en: 'Draft Directive', 'zh-CN': '指令草案'},
    RESOLUTION_DRAFT: {en: 'Draft Resolution', 'zh-CN': '决议草案'}};
  return names[type][language];
}

export type AutomaticContentName =
  | {kind: 'FILE'; fileType: import('./delegate-files.js').DelegateFileType; sessionOrdinal: number; ordinal: number}
  | {kind: 'SESSION'; ordinal: number}
  | {kind: 'GENERAL_SPEAKERS_LIST'}
  | {kind: 'MODERATED_CAUCUS'; topic: string; customTitle: string | null}
  | {kind: 'RESOLUTION'; sessionOrdinal: number; ordinal: number; customTitle: string | null}
  | {kind: 'AMENDMENT'; ordinal: number; customTitle: string | null}
  | {kind: 'STRAWPOLL'; ordinal: number; question: string};

function positiveOrdinal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid resource ordinal');
  return String(value);
}

/** Never inspect user text to decide whether it is an automatic name. */
export function formatCommitteeContent(resource: AutomaticContentName, language: ContentLanguage): string {
  if ('customTitle' in resource && resource.customTitle !== null) return resource.customTitle;
  const zh = language === 'zh-CN';
  switch (resource.kind) {
    case 'FILE': return `${delegateFileTypeName(resource.fileType, language)} ${positiveOrdinal(resource.sessionOrdinal)}.${positiveOrdinal(resource.ordinal)}`;
    case 'SESSION': return zh ? `第${positiveOrdinal(resource.ordinal)}会期` : `Session ${positiveOrdinal(resource.ordinal)}`;
    case 'GENERAL_SPEAKERS_LIST': return zh ? '主发言名单' : "General Speaker's List";
    case 'MODERATED_CAUCUS': return resource.topic || (zh ? '未命名有主持核心磋商' : 'Untitled caucus');
    case 'RESOLUTION': return `${zh ? '决议草案' : 'Draft Resolution'} ${positiveOrdinal(resource.sessionOrdinal)}.${positiveOrdinal(resource.ordinal)}`;
    case 'AMENDMENT': return `${zh ? '新修正案' : 'New Amendment '}${positiveOrdinal(resource.ordinal)}`;
    case 'STRAWPOLL': return resource.question || `${zh ? '新意向性投票' : 'New Strawpoll '}${positiveOrdinal(resource.ordinal)}`;
  }
}
