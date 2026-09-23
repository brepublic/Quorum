import * as React from 'react';
import type {FileEntry} from '@quorum/contracts';
import {Label} from 'semantic-ui-react';
import {t, useLanguage} from '../i18n';

const FILE_STATUS: Record<FileEntry['status'], string> = {
  UPLOAD_COMPLETE: "Pending review", PENDING_REVIEW: "Pending review", PUBLISHED: "Published", REJECTED: "File status: Rejected", DELETED: "Deleted"
};
const FILE_STATUS_APPEARANCE = {
  UPLOAD_COMPLETE: {color: 'blue', icon: 'clock outline'},
  PENDING_REVIEW: {color: 'blue', icon: 'clock outline'},
  PUBLISHED: {color: 'green', icon: 'check circle'},
  REJECTED: {color: 'red', icon: 'times circle'},
  DELETED: {color: 'grey', icon: 'trash alternate outline'}
} as const;
export function FileStatusLabel({status}: {status: FileEntry['status']}) {
  useLanguage();
  return <Label basic className="self-hosted-file-status" {...FILE_STATUS_APPEARANCE[status]} content={t(FILE_STATUS[status])} />;
}
