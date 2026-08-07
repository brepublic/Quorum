import firebase from 'firebase/compat/app';
import {getLanguage, Language, SUPPORTED_LANGUAGES} from '../i18n';
import {MemberData, MemberID} from '../modules/member';

export type UserTemplateID = string;

export interface UserTemplateData {
  /** Legacy-compatible name in the template's default language. */
  name: string;
  defaultLanguage?: Language;
  names?: Partial<Record<Language, string>>;
  members: Record<MemberID, MemberData>;
}

export const templateDefaultLanguage = (
  template: UserTemplateData,
  fallback: Language = getLanguage()
): Language => SUPPORTED_LANGUAGES.includes(template.defaultLanguage as Language)
  ? template.defaultLanguage as Language
  : fallback;

export const templateDisplayName = (
  template: UserTemplateData,
  language: Language = getLanguage()
): string => {
  const localizedName = template.names?.[language]?.trim();
  if (localizedName) {
    return localizedName;
  }

  const defaultName = template.names?.[templateDefaultLanguage(template, language)]?.trim()
    || template.name?.trim();
  if (defaultName) {
    return defaultName;
  }

  return Object.values(template.names || {}).find(candidate => candidate?.trim())?.trim() || '';
};

export const userTemplatesRef = (uid: string): firebase.database.Reference =>
  firebase.database().ref('templates').child(uid);

export const putUserTemplate = (
  uid: string,
  templateID: UserTemplateID | undefined,
  template: UserTemplateData
): Promise<firebase.database.Reference> => {
  const ref = templateID
    ? userTemplatesRef(uid).child(templateID)
    : userTemplatesRef(uid).push();

  return ref.set(template).then(() => ref);
};

export const deleteUserTemplate = (uid: string, templateID: UserTemplateID): Promise<void> =>
  userTemplatesRef(uid).child(templateID).remove();

export const templateMembers = (template: UserTemplateData): MemberData[] =>
  Object.values(template.members || {});
