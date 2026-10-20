export interface ServerVolumeFile {
  id: string;
  blobId: string | null;
  committeeId: string | null;
  committeeName: string | null;
  committeeStatus: string | null;
  bindingStatus: string | null;
  path: string;
  sizeBytes: number;
  present: boolean;
  modifiedAt: number | null;
  state: string;
  hasOtherCopy: boolean;
  references: Array<{fileId: string; name: string; version: number}>;
}
export interface ServerVolumeInventory {
  files: ServerVolumeFile[];
  page: number;
  total: number;
  totalBytes: number;
  rootPath: string;
}
export interface ServerVolumeCleanup {
  id: string;
  scope: 'ALL' | 'ARCHIVED' | 'SELECTED';
  status: 'PREVIEW' | 'RUNNING' | 'COMPLETED';
  total: number;
  completed: number;
  failed: number;
  sizeBytes: number;
  withoutOtherCopy: number;
  committeeCount: number;
  files?: ServerVolumeFile[];
}
