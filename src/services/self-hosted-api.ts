import type {
  CommitteeEventEnvelope,
  AuthoritativeTimer,
  SpeakerList,
  SpeechRecord,
  ProceedingMotion,
  FormalBallot,
  Strawpoll,
  CreatedStrawpoll,
  ProceedingDocument,
  CommitteeNote,
  CommitteeSummary,
  CommitteeTemplate,
  CommitteeTemplateInput,
  CommitteeTextPost,
  CommitteeWorkspaceSnapshot,
  CountryTemplate,
  CountryTemplateInput,
  MeetingSession,
  PendingHostCommit,
  RollCall,
  Stage4CommitteeSeat,
  AttendanceEvent,
  CommitteePoint,
  CommitteeDeletionJob,
  FileEntry,
  FileUpload,
  S3ProviderConfigSummary,
  StorageBinding,
  StorageMigration,
  StoragePairingCode,
  StorageProviderType,
  StorageHost,
  StorageAgentConflict,
  StorageAgentConflictResolution
} from '@quorum/contracts';
import {COMMITTEE_EVENT_DEFINITIONS, type RealtimeSyncState} from '@quorum/contracts';

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

export function newIdempotencyKey(): string { return key(); }

function uploadContentRequest(uploadId: string, file: File, idempotencyKey: string, options: {
  signal?: AbortSignal;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
} = {}): Promise<FileUpload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = () => options.signal?.removeEventListener('abort', abort);
    xhr.open('PUT', `/api/v1/file-uploads/${encodeURIComponent(uploadId)}/content`);
    xhr.withCredentials = true;
    const csrf = cookie('__Host-quorum_csrf');
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.setRequestHeader('idempotency-key', idempotencyKey);
    xhr.upload.onprogress = event => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.onload = () => {
      finish();
      let payload: ApiSuccess<FileUpload> | ApiFailure;
      try { payload = JSON.parse(xhr.responseText) as ApiSuccess<FileUpload> | ApiFailure; }
      catch { reject(new SelfHostedApiError(xhr.status, 'INTERNAL_ERROR', 'Upload response was invalid.')); return; }
      if (xhr.status < 200 || xhr.status >= 300 || 'error' in payload) {
        const error = 'error' in payload ? payload.error
          : {code: 'INTERNAL_ERROR', message: 'Upload failed.', requestId: undefined, details: undefined};
        reject(new SelfHostedApiError(xhr.status, error.code, error.message, error.requestId, error.details));
        return;
      }
      resolve(payload.data);
    };
    xhr.onerror = () => { finish(); reject(new SelfHostedApiError(0, 'INTERNAL_ERROR', 'Upload connection was interrupted.')); };
    xhr.onabort = () => { finish(); reject(new DOMException('Upload cancelled.', 'AbortError')); };
    if (options.signal?.aborted) { reject(new DOMException('Upload cancelled.', 'AbortError')); return; }
    options.signal?.addEventListener('abort', abort, {once: true});
    options.onProgress?.(0, file.size);
    xhr.send(file);
  });
}

export interface S3ProviderConfigInput {
  displayName: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  allowPrivateNetwork: boolean;
  credentials: {accessKeyId: string; secretAccessKey: string};
}

const knownCommitteeEvents = new Set<string>(COMMITTEE_EVENT_DEFINITIONS.map(item => item.name));

function realtimeClientId(): string {
  const storageKey = 'quorum-self-hosted-realtime-client';
  const existing = window.localStorage.getItem(storageKey);
  if (existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(storageKey, created);
  return created;
}

export function parseSseFrame(frame: string): {id?: number; type?: string; data?: unknown} {
  let id: number | undefined; let type: string | undefined; const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    const value = separator < 0 ? '' : rawLine.slice(separator + 1).replace(/^ /, '');
    if (field === 'id' && /^(0|[1-9]\d*)$/.test(value)) id = Number(value);
    else if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return {id, type};
  try { return {id, type, data: JSON.parse(data.join('\n'))}; }
  catch { return {id, type, data: undefined}; }
}

export interface CommitteeEventStreamCallbacks {
  onEvent(event: CommitteeEventEnvelope): void;
  onState(state: RealtimeSyncState): void;
  onResyncRequired(): Promise<number>;
}

function openCommitteeEventStream(committeeId: string, initialAfter: number,
  callbacks: CommitteeEventStreamCallbacks): () => void {
  const controller = new AbortController(); let cursor = initialAfter;
  const clientId = realtimeClientId();
  const resync = async () => { callbacks.onState('RESYNCING'); cursor = await callbacks.onResyncRequired(); };
  const delay = () => new Promise<void>(resolve => {
    const timer = window.setTimeout(resolve, 1_000);
    controller.signal.addEventListener('abort', () => {window.clearTimeout(timer); resolve();}, {once: true});
  });
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/api/v1/committees/${committeeId}/events?after=${cursor}&clientId=${encodeURIComponent(clientId)}`,
          {credentials: 'same-origin', headers: {'last-event-id': String(cursor)}, signal: controller.signal});
        if (response.status === 410) { await resync(); continue; }
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          callbacks.onState('OFFLINE_READONLY'); return;
        }
        if (!response.ok || !response.body) throw new Error('SSE unavailable');
        callbacks.onState('LIVE');
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value ?? new Uint8Array(), {stream: !chunk.done}).replaceAll('\r\n', '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = parseSseFrame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            if (frame.id === undefined || !frame.type || frame.data === undefined) continue;
            if (frame.id <= cursor) continue;
            if (frame.id !== cursor + 1 || !knownCommitteeEvents.has(frame.type)) { await resync(); continue; }
            cursor = frame.id;
            callbacks.onEvent(frame.data as CommitteeEventEnvelope);
          }
          if (chunk.done) break;
        }
      } catch {
        if (controller.signal.aborted) return;
        callbacks.onState('DEGRADED');
      }
      if (!controller.signal.aborted) await delay();
    }
  })();
  return () => controller.abort();
}

export const selfHostedApi = {
  operationsStatus() {
    return request<{database: {schemaCompatibility: number; serverTime: string};
      storage: {state: 'normal' | 'warning' | 'critical'; usageRatio: number; availableBytes: number};
      accounts: Record<'active' | 'disabled' | 'anonymized', number>;
      committees: Record<'active' | 'paused' | 'archived' | 'deleting', number>;
      queues: {blobDelete: number; uploadStaging: number; migration: number; agentTasks: number; committeeDeletion: number};
      retention: {lastStatus: string | null; lastCompletedAt: string | null}}>('/api/v1/admin/operations/status');
  },
  async listCommittees(): Promise<CommitteeSummary[]> {
    return (await request<{committees: CommitteeSummary[]}>('/api/v1/committees')).committees;
  },
  createCommittee(input: {name: string; visibility: 'PUBLIC' | 'PRIVATE'; committeeTemplateId?: string; countryTemplateKey?: string}) {
    return request<CommitteeSummary>('/api/v1/committees', {method: 'POST', body: input, idempotencyKey: key()});
  },
  snapshot(id: string) { return request<CommitteeWorkspaceSnapshot>(`/api/v1/committees/${id}/snapshot`); },
  openCommitteeEvents: openCommitteeEventStream,
  createTimer(committeeId: string, ownerType: 'COMMITTEE' | 'SPEAKER_LIST' | 'CAUCUS' | 'SPEECH', ownerId: string,
    durationMs: number) {
    return request<AuthoritativeTimer>(`/api/v1/committees/${committeeId}/timers`, {method: 'POST',
      body: {ownerType, ownerId, durationMs}, idempotencyKey: key()});
  },
  commandTimer(id: string, command: 'start' | 'pause' | 'resume' | 'extend' | 'reset' | 'expire',
    baseRevision: number, durationMs?: number) {
    return request<AuthoritativeTimer>(`/api/v1/timers/${id}/${command}`, {method: 'POST',
      body: {baseRevision, ...(durationMs === undefined ? {} : {durationMs})}});
  },
  createSpeakerList(committeeId: string, input: {meetingSessionId: string; kind: 'GENERAL' | 'MODERATED_CAUCUS';
    topic?: string; defaultSpeechMs: number; totalDurationMs?: number}) {
    return request<SpeakerList>(`/api/v1/committees/${committeeId}/speaker-lists`, {method: 'POST',
      body: input, idempotencyKey: key()});
  },
  joinSpeakerQueue(id: string, seatId?: string) {
    return request<SpeakerList>(`/api/v1/speaker-lists/${id}/queue`, {method: 'POST',
      body: seatId ? {seatId} : {}, idempotencyKey: key()});
  },
  reorderSpeakerQueue(id: string, baseRevision: number, entryIds: string[]) {
    return request<SpeakerList>(`/api/v1/speaker-lists/${id}/reorder`, {method: 'POST', body: {baseRevision, entryIds}});
  },
  advanceSpeakerQueue(id: string, baseRevision: number) {
    return request<SpeakerList>(`/api/v1/speaker-lists/${id}/advance`, {method: 'POST', body: {baseRevision}});
  },
  commandSpeech(listId: string, command: 'start' | 'pause' | 'resume' | 'complete', baseRevision: number) {
    return request<SpeechRecord>(`/api/v1/speaker-lists/${listId}/speech/${command}`,
      {method: 'POST', body: {baseRevision}});
  },
  yieldSpeech(id: string, baseRevision: number, type: 'CHAIR' | 'SEAT' | 'QUESTIONS' | 'COMMENTS', targetSeatId?: string) {
    return request<SpeechRecord>(`/api/v1/speeches/${id}/yield`, {method: 'POST',
      body: {baseRevision, type, ...(targetSeatId ? {targetSeatId} : {})}});
  },
  recordSpeechContribution(id: string, type: 'QUESTION' | 'COMMENT', content: string, seatId?: string) {
    return request<SpeechRecord>(`/api/v1/speeches/${id}/contributions`, {method: 'POST',
      body: {type, content, ...(seatId ? {seatId} : {})}});
  },
  proposeMotion(committeeId: string, input: {meetingSessionId: string; motionTypeId: string;
    parameters?: Record<string, unknown>; onBehalfOfSeatId?: string}) {
    return request<ProceedingMotion>(`/api/v1/committees/${committeeId}/motions`, {method: 'POST',
      body: input, idempotencyKey: key()});
  },
  secondMotion(id: string, onBehalfOfSeatId?: string) {
    return request<ProceedingMotion>(`/api/v1/motions/${id}/second`, {method: 'POST',
      body: onBehalfOfSeatId ? {onBehalfOfSeatId} : {}, idempotencyKey: key()});
  },
  decideMotion(id: string, baseRevision: number, result: 'PASSED' | 'FAILED') {
    return request<ProceedingMotion>(`/api/v1/motions/${id}/decide`, {method: 'POST', body: {baseRevision, result}});
  },
  createBallot(committeeId: string, input: {meetingSessionId: string; subjectType: 'MOTION' | 'RESOLUTION' | 'AMENDMENT';
    subjectId: string; procedural: boolean; thresholdKind: 'SIMPLE_MAJORITY' | 'TWO_THIRDS'}) {
    return request<FormalBallot>(`/api/v1/committees/${committeeId}/ballots`, {method: 'POST',
      body: input, idempotencyKey: key()});
  },
  castVote(id: string, choice: 'FOR' | 'AGAINST' | 'ABSTAIN', onBehalfOfSeatId?: string) {
    return request<FormalBallot>(`/api/v1/ballots/${id}/votes`, {method: 'POST',
      body: {choice, ...(onBehalfOfSeatId ? {onBehalfOfSeatId} : {})}, idempotencyKey: key()});
  },
  correctVote(id: string, baseRevision: number, seatId: string, choice: 'FOR' | 'AGAINST' | 'ABSTAIN', reason: string) {
    return request<FormalBallot>(`/api/v1/ballots/${id}/correct-vote`, {method: 'POST',
      body: {baseRevision, seatId, choice, reason}});
  },
  closeBallot(id: string, baseRevision: number) {
    return request<FormalBallot>(`/api/v1/ballots/${id}/close`, {method: 'POST', body: {baseRevision}});
  },
  publishBallot(id: string, baseRevision: number) {
    return request<FormalBallot>(`/api/v1/ballots/${id}/publish`, {method: 'POST', body: {baseRevision}});
  },
  createStrawpoll(committeeId: string, input: {meetingSessionId: string; question: string;
    votingMode: 'ANONYMOUS' | 'SEAT_AUTHENTICATED'; multipleChoice: boolean; options: string[]}) {
    return request<CreatedStrawpoll>(`/api/v1/committees/${committeeId}/strawpolls`, {method: 'POST',
      body: input, idempotencyKey: key()});
  },
  voteStrawpoll(id: string, input: {optionIds: string[]; onBehalfOfSeatId?: string;
    anonymousAccessToken?: string}) {
    return request<Strawpoll>(`/api/v1/strawpolls/${id}/votes`, {method: 'POST', body: input, idempotencyKey: key()});
  },
  closeStrawpoll(id: string, baseRevision: number) {
    return request<Strawpoll>(`/api/v1/strawpolls/${id}/close`, {method: 'POST', body: {baseRevision}});
  },
  createResolution(committeeId: string, input: {meetingSessionId: string; title: string; content: string;
    onBehalfOfSeatId?: string}) {
    return request<ProceedingDocument>(`/api/v1/committees/${committeeId}/resolutions`, {method: 'POST',
      body: input, idempotencyKey: key()});
  },
  createAmendment(resolutionId: string, input: {meetingSessionId: string; title: string; content: string;
    onBehalfOfSeatId?: string}) {
    return request<ProceedingDocument>(`/api/v1/resolutions/${resolutionId}/amendments`, {method: 'POST',
      body: input, idempotencyKey: key()});
  },
  createDocumentVersion(id: string, input: {baseRevision: number; title: string; content: string;
    onBehalfOfSeatId?: string}) {
    return request<ProceedingDocument>(`/api/v1/documents/${id}/versions`, {method: 'POST', body: input});
  },
  commandDocument(id: string, baseRevision: number, action: 'PUBLISH' | 'POSTPONE' | 'RESUME' | 'RECOMMEND_BALLOT',
    ruleStableId: string) {
    return request<ProceedingDocument>(`/api/v1/documents/${id}/commands`, {method: 'POST',
      body: {baseRevision, action, ruleStableId}});
  },
  addDocumentDiscussion(id: string, input: {content: string; ruleStableId: string; onBehalfOfSeatId?: string}) {
    return request<ProceedingDocument>(`/api/v1/documents/${id}/discussion`, {method: 'POST',
      body: input, idempotencyKey: key()});
  },
  updateCommittee(id: string, baseRevision: number, patch: Record<string, unknown>) {
    return request<CommitteeSummary>(`/api/v1/committees/${id}`, {method: 'PATCH', body: {baseRevision, patch}});
  },
  archiveCommittee(id: string, baseRevision: number) {
    return request<CommitteeSummary>(`/api/v1/committees/${id}/archive`, {method: 'POST', body: {baseRevision}});
  },
  requestCommitteeDeletion(id: string, baseRevision: number, confirmationName: string) {
    return request<CommitteeDeletionJob>(`/api/v1/committees/${id}`, {method: 'DELETE',
      body: {baseRevision, confirmationName}, idempotencyKey: key()});
  },
  committeeExportUrl(id: string) { return `/api/v1/committees/${encodeURIComponent(id)}/export`; },
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
  },
  listFiles(committeeId: string) {
    return request<FileEntry[]>(`/api/v1/committees/${committeeId}/files`);
  },
  listPendingHostCommits(committeeId: string) {
    return request<FileUpload[]>(`/api/v1/committees/${committeeId}/file-uploads/pending-host-commit`);
  },
  createFileUpload(committeeId: string, input: {logicalName: string; originalName: string; mediaType: string;
    expectedSizeBytes: number; sha256: string}, idempotencyKey = key()) {
    return request<FileUpload>(`/api/v1/committees/${committeeId}/file-uploads`, {method: 'POST',
      body: input, idempotencyKey});
  },
  uploadFileContent(uploadId: string, file: File, idempotencyKey = key(), options: {
    signal?: AbortSignal; onProgress?: (sentBytes: number, totalBytes: number) => void;
  } = {}) {
    return uploadContentRequest(uploadId, file, idempotencyKey, options);
  },
  commitFileUpload(uploadId: string, idempotencyKey = key()) {
    return request<FileEntry | PendingHostCommit>(`/api/v1/file-uploads/${uploadId}/commit`,
      {method: 'POST', body: {}, idempotencyKey});
  },
  submitFileForReview(fileId: string, baseRevision: number, idempotencyKey = key()) {
    return request<FileEntry>(`/api/v1/files/${fileId}/submit-review`, {method: 'POST',
      body: {baseRevision}, idempotencyKey});
  },
  publishFile(fileId: string, baseRevision: number, idempotencyKey = key()) {
    return request<FileEntry>(`/api/v1/files/${fileId}/publish`, {method: 'POST',
      body: {baseRevision}, idempotencyKey});
  },
  deleteFile(fileId: string, baseRevision: number, idempotencyKey = key()) {
    return request<{id: string; fileEntryId: string}>(`/api/v1/files/${fileId}`, {method: 'DELETE',
      body: {baseRevision}, idempotencyKey});
  },
  fileDownloadUrl(fileId: string) {
    return `/api/v1/files/${encodeURIComponent(fileId)}/download`;
  },
  listStorageBindings(committeeId: string) {
    return request<StorageBinding[]>(`/api/v1/committees/${committeeId}/storage-bindings`);
  },
  createServerVolumeBinding(committeeId: string, baseRevision: number, idempotencyKey = key()) {
    return request<StorageBinding>(`/api/v1/committees/${committeeId}/storage-bindings/server-volume`, {
      method: 'POST', body: {baseRevision}, idempotencyKey});
  },
  createS3Binding(committeeId: string, baseRevision: number, providerConfigId: string, idempotencyKey = key()) {
    return request<StorageBinding>(`/api/v1/committees/${committeeId}/storage-bindings/s3`, {method: 'POST',
      body: {baseRevision, providerConfigId}, idempotencyKey});
  },
  createChairAgentBinding(committeeId: string, baseRevision: number, idempotencyKey = key()) {
    return request<StorageBinding>(`/api/v1/committees/${committeeId}/storage-bindings/chair-agent`, {
      method: 'POST', body: {baseRevision}, idempotencyKey});
  },
  listStorageHosts(committeeId: string) {
    return request<StorageHost[]>(`/api/v1/committees/${committeeId}/storage-hosts`);
  },
  createStoragePairingCode(committeeId: string, baseRevision: number, purpose: 'INITIAL' | 'TRANSFER') {
    return request<StoragePairingCode>(
      `/api/v1/committees/${committeeId}/storage-agent/pairing-codes`, {
        method: 'POST', body: {baseRevision, purpose}
      });
  },
  revokeStorageHost(committeeId: string, hostId: string, baseRevision: number) {
    return request<StorageHost>(`/api/v1/committees/${committeeId}/storage-hosts/${hostId}/revoke`, {
      method: 'POST', body: {baseRevision}
    });
  },
  listStorageAgentConflicts(committeeId: string) {
    return request<StorageAgentConflict[]>(`/api/v1/committees/${committeeId}/storage-agent-conflicts`);
  },
  resolveStorageAgentConflict(committeeId: string, conflictId: string, input: {baseRevision: number;
    leaseGeneration: number; fileRevision: number | null; action: StorageAgentConflictResolution;
    logicalName?: string}, idempotencyKey = key()) {
    return request<StorageAgentConflict>(
      `/api/v1/committees/${committeeId}/storage-agent-conflicts/${conflictId}/resolve`, {
        method: 'POST', body: input as unknown as Record<string, unknown>, idempotencyKey
      });
  },
  listS3ProviderConfigs() {
    return request<S3ProviderConfigSummary[]>('/api/v1/storage-provider-configs/s3');
  },
  createS3ProviderConfig(input: S3ProviderConfigInput, idempotencyKey = key()) {
    return request<S3ProviderConfigSummary>('/api/v1/admin/storage-provider-configs/s3', {method: 'POST',
      body: input as unknown as Record<string, unknown>, idempotencyKey});
  },
  updateS3ProviderConfig(configId: string, baseRevision: number,
    input: Omit<S3ProviderConfigInput, 'credentials'> & {status: 'ACTIVE' | 'DISABLED';
      credentials?: S3ProviderConfigInput['credentials']}, idempotencyKey = key()) {
    return request<S3ProviderConfigSummary>(`/api/v1/admin/storage-provider-configs/${configId}`, {method: 'PUT',
      body: {baseRevision, ...input} as unknown as Record<string, unknown>, idempotencyKey});
  },
  verifyS3ProviderConfig(configId: string, idempotencyKey = key()) {
    return request<S3ProviderConfigSummary>(`/api/v1/admin/storage-provider-configs/${configId}/verify`, {
      method: 'POST', body: {}, idempotencyKey});
  },
  listStorageMigrations(committeeId: string) {
    return request<StorageMigration[]>(`/api/v1/committees/${committeeId}/storage-migrations`);
  },
  createStorageMigration(committeeId: string, baseRevision: number, targetProviderType: StorageProviderType,
    targetProviderConfigId?: string, idempotencyKey = key()) {
    return request<StorageMigration>(`/api/v1/committees/${committeeId}/storage-migrations`, {method: 'POST',
      body: {baseRevision, targetProviderType,
        ...(targetProviderConfigId ? {targetProviderConfigId} : {})}, idempotencyKey});
  },
  retryStorageMigration(id: string, baseRevision: number, idempotencyKey = key()) {
    return request<StorageMigration>(`/api/v1/storage-migrations/${id}/retry`, {method: 'POST',
      body: {baseRevision}, idempotencyKey});
  },
  confirmStorageMigration(id: string, baseRevision: number, idempotencyKey = key()) {
    return request<StorageMigration>(`/api/v1/storage-migrations/${id}/confirm`, {method: 'POST',
      body: {baseRevision}, idempotencyKey});
  },
  cancelStorageMigration(id: string, baseRevision: number, idempotencyKey = key()) {
    return request<StorageMigration>(`/api/v1/storage-migrations/${id}/cancel`, {method: 'POST',
      body: {baseRevision}, idempotencyKey});
  }
};

export type SelfHostedApi = typeof selfHostedApi;
