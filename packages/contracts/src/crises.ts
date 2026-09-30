import type {AuthoritativeTimer} from './stage5.js';

export type CrisisUpdateStatus = 'UNPUBLISHED' | 'PENDING' | 'SUPERSEDED' | 'ENDED';
export interface CrisisUpdate {
  id: string;
  groupId: string;
  ordinal: number;
  title: string;
  status: CrisisUpdateStatus;
  handlingDurationMs: number | null;
  notice: {id: string; logicalName: string; status: string} | null;
  revision: number;
  publishedAt: string | null;
}
export interface CrisisGroup {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  sessionOrdinal: number;
  ordinal: number;
  nextUpdateOrdinal: number;
  revision: number;
  endedAt: string | null;
  autoStartAt: string | null;
  timer: AuthoritativeTimer;
  updates: CrisisUpdate[];
}
export interface CrisisNoticePreview {
  sessionOrdinal: number;
  groupOrdinal: number;
  updateOrdinal: number;
  groupId: string | null;
  updateId: string | null;
  replacement: {id: string; logicalName: string; originalName?: string} | null;
}

export function parseCrisisNoticeName(name: string): {sessionOrdinal: number; groupOrdinal: number; updateOrdinal: number} | null {
  const match = /^(?:危机通告|Crisis Notice)\s+(\d+)\.(\d+)\.(\d+)(?:\s*[—–-]\s*.+)?$/i.exec(name.trim());
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > 2147483647)) return null;
  return {sessionOrdinal: numbers[0]!, groupOrdinal: numbers[1]!, updateOrdinal: numbers[2]!};
}

export function suggestCrisisNoticeName(groups: readonly CrisisGroup[], sessionOrdinal: number, nextGroupOrdinal: number, language: 'en' | 'zh-CN'): string {
  const active = groups.filter(group => !group.endedAt && group.updates.some(update => update.status === 'PENDING'));
  const prefix = language === 'zh-CN' ? '危机通告' : 'Crisis Notice';
  if (active.length > 1) return `${prefix} ${sessionOrdinal}.`;
  const group = active[0];
  return group ? `${prefix} ${group.sessionOrdinal}.${group.ordinal}.${group.updates.find(update => update.status === 'UNPUBLISHED')?.ordinal ?? group.nextUpdateOrdinal}`
    : `${prefix} ${sessionOrdinal}.${nextGroupOrdinal}.1`;
}
