import firebase from 'firebase/compat/app';
import {MemberData, MemberID} from '../modules/member';

export type UserTemplateID = string;

export interface UserTemplateData {
  name: string;
  members: Record<MemberID, MemberData>;
}

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
