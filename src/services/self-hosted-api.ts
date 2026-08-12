import type {
  CommitteeNote,
  CommitteeSummary,
  CommitteeTemplate,
  CommitteeTemplateInput,
  CommitteeTextPost,
  CommitteeWorkspaceSnapshot,
  CountryTemplate,
  CountryTemplateInput,
  MeetingSession,
  RollCall,
  Stage4CommitteeSeat,
  AttendanceEvent,
  CommitteePoint
} from '@quorum/contracts';

interface ApiSuccess<T> {data: T; meta: {requestId: string}}
interface ApiFailure {error: {code: string; message: string; requestId: string; details?: unknown}}

export class SelfHostedApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string,
    readonly requestId?: string, readonly details?: unknown) {
    super(message); this.name = 'SelfHostedApiError';
  }
}

function cookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(path: string, options: {
  method?: Method; body?: Record<string, unknown>; idempotencyKey?: string;
} = {}): Promise<T> {
  const method = options.method ?? 'GET'; const headers: Record<string, string> = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = cookie('__Host-quorum_csrf'); if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  const response = await fetch(path, {method, credentials: 'same-origin', headers,
    ...(options.body ? {body: JSON.stringify(options.body)} : {})});
  const payload = await response.json() as ApiSuccess<T> | ApiFailure;
  if (!response.ok || 'error' in payload) {
    const error = 'error' in payload ? payload.error
      : {code: 'INTERNAL_ERROR', message: 'Request failed.', requestId: undefined, details: undefined};
    throw new SelfHostedApiError(response.status, error.code, error.message, error.requestId, error.details);
  }
  return payload.data;
}

function key(): string { return crypto.randomUUID(); }

export const selfHostedApi = {
  async listCommittees(): Promise<CommitteeSummary[]> {
    return (await request<{committees: CommitteeSummary[]}>('/api/v1/committees')).committees;
  },
  createCommittee(input: {name: string; visibility: 'PUBLIC' | 'PRIVATE'; committeeTemplateId?: string; countryTemplateKey?: string}) {
    return request<CommitteeSummary>('/api/v1/committees', {method: 'POST', body: input, idempotencyKey: key()});
  },
  snapshot(id: string) { return request<CommitteeWorkspaceSnapshot>(`/api/v1/committees/${id}/snapshot`); },
  updateCommittee(id: string, baseRevision: number, patch: Record<string, unknown>) {
    return request<CommitteeSummary>(`/api/v1/committees/${id}`, {method: 'PATCH', body: {baseRevision, patch}});
  },
  listCountryTemplates: async () => (await request<{countryTemplates: CountryTemplate[]}>('/api/v1/country-templates')).countryTemplates,
  createCountryTemplate(input: CountryTemplateInput) {
    return request<CountryTemplate>('/api/v1/country-templates', {method: 'POST', body: input as unknown as Record<string, unknown>, idempotencyKey: key()});
  },
  cloneCountryTemplate(id: string) {
    return request<CountryTemplate>(`/api/v1/country-templates/${encodeURIComponent(id)}/clone`, {method: 'POST', body: {}, idempotencyKey: key()});
  },
  updateCountryTemplate(id: string, baseRevision: number, template: CountryTemplateInput) {
    return request<CountryTemplate>(`/api/v1/country-templates/${id}`, {method: 'PUT',
      body: {baseRevision, template: template as unknown as Record<string, unknown>}});
  },
  deleteCountryTemplate(id: string) {
    return request<{deleted: true}>(`/api/v1/country-templates/${encodeURIComponent(id)}`, {method: 'DELETE'});
  },
  listCommitteeTemplates: async () => (await request<{committeeTemplates: CommitteeTemplate[]}>('/api/v1/committee-templates')).committeeTemplates,
  createCommitteeTemplate(input: CommitteeTemplateInput) {
    return request<CommitteeTemplate>('/api/v1/committee-templates', {method: 'POST', body: input as unknown as Record<string, unknown>, idempotencyKey: key()});
  },
  cloneCommitteeTemplate(id: string) {
    return request<CommitteeTemplate>(`/api/v1/committee-templates/${id}/clone`, {method: 'POST', body: {}, idempotencyKey: key()});
  },
  updateCommitteeTemplate(id: string, baseRevision: number, template: CommitteeTemplateInput) {
    return request<CommitteeTemplate>(`/api/v1/committee-templates/${id}`, {method: 'PUT',
      body: {baseRevision, template: template as unknown as Record<string, unknown>}});
  },
  deleteCommitteeTemplate(id: string) {
    return request<{deleted: true}>(`/api/v1/committee-templates/${id}`, {method: 'DELETE'});
  },
  createSeat(committeeId: string, input: Record<string, unknown>) {
    return request<Stage4CommitteeSeat>(`/api/v1/committees/${committeeId}/seats`, {method: 'POST', body: input, idempotencyKey: key()});
  },
  updateSeat(committeeId: string, seatId: string, baseRevision: number, patch: Record<string, unknown>) {
    return request<Stage4CommitteeSeat>(`/api/v1/committees/${committeeId}/seats/${seatId}`, {method: 'PUT', body: {baseRevision, patch}});
  },
  grantChair(committeeId: string, userId: string, baseRevision: number) {
    return request<CommitteeSummary>(`/api/v1/committees/${committeeId}/chairs`, {method: 'POST', body: {userId, baseRevision}});
  },
  assignSeat(committeeId: string, seatId: string, userId: string) {
    return request<{id: string}>(`/api/v1/committees/${committeeId}/seat-assignments`, {method: 'POST', body: {seatId, userId}});
  },
  createNote(committeeId: string, input: {title?: string; content: string; sortOrder?: number}) {
    return request<CommitteeNote>(`/api/v1/committees/${committeeId}/notes`, {method: 'POST', body: input, idempotencyKey: key()});
  },
  updateNote(id: string, baseRevision: number, patch: Record<string, unknown>) {
    return request<CommitteeNote>(`/api/v1/notes/${id}`, {method: 'PUT', body: {baseRevision, patch}});
  },
  deleteNote(id: string, baseRevision: number) {
    return request<{deleted: true}>(`/api/v1/notes/${id}`, {method: 'DELETE', body: {baseRevision}});
  },
  createTextPost(committeeId: string, input: {title?: string; content: string; onBehalfOfSeatId?: string}) {
    return request<CommitteeTextPost>(`/api/v1/committees/${committeeId}/text-posts`, {method: 'POST', body: input, idempotencyKey: key()});
  },
  updateTextPost(id: string, baseRevision: number, patch: Record<string, unknown>) {
    return request<CommitteeTextPost>(`/api/v1/text-posts/${id}`, {method: 'PUT', body: {baseRevision, patch}});
  },
  deleteTextPost(id: string, baseRevision: number) {
    return request<{deleted: true}>(`/api/v1/text-posts/${id}`, {method: 'DELETE', body: {baseRevision}});
  },
  startMeetingSession(committeeId: string, phaseId?: string) {
    return request<MeetingSession>(`/api/v1/committees/${committeeId}/meeting-sessions`, {method: 'POST', body: phaseId ? {phaseId} : {}});
  },
  closeMeetingSession(id: string, baseRevision: number) {
    return request<MeetingSession>(`/api/v1/meeting-sessions/${id}/close`, {method: 'POST', body: {baseRevision}});
  },
  startRollCall(committeeId: string, meetingSessionId: string) {
    return request<RollCall>(`/api/v1/committees/${committeeId}/roll-calls`, {method: 'POST', body: {meetingSessionId}, idempotencyKey: key()});
  },
  recordRollCallResponse(id: string, baseRevision: number, seatId: string, response: string) {
    return request<RollCall>(`/api/v1/roll-calls/${id}/record-response`, {method: 'POST', body: {baseRevision, seatId, response}});
  },
  undoRollCall(id: string, baseRevision: number) {
    return request<RollCall>(`/api/v1/roll-calls/${id}/undo`, {method: 'POST', body: {baseRevision}});
  },
  resetRollCall(id: string, baseRevision: number) {
    return request<RollCall>(`/api/v1/roll-calls/${id}/reset`, {method: 'POST', body: {baseRevision}});
  },
  createAttendanceEvent(committeeId: string, meetingSessionId: string, seatId: string, type: string) {
    return request<AttendanceEvent>(`/api/v1/committees/${committeeId}/attendance-events`,
      {method: 'POST', body: {meetingSessionId, seatId, type}});
  },
  createPoint(committeeId: string, input: {meetingSessionId: string; pointTypeId: string; content: string; onBehalfOfSeatId?: string}) {
    return request<CommitteePoint>(`/api/v1/committees/${committeeId}/points`, {method: 'POST', body: input, idempotencyKey: key()});
  },
  resolvePoint(id: string, baseRevision: number, status: string, chairResponse: string) {
    return request<CommitteePoint>(`/api/v1/points/${id}/resolve`, {method: 'POST', body: {baseRevision, status, chairResponse}});
  }
};

export type SelfHostedApi = typeof selfHostedApi;
