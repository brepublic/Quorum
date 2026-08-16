import {beforeEach, describe, expect, it, vi} from 'vitest';
import {parseSseFrame, selfHostedApi, SelfHostedApiError} from './self-hosted-api';

describe('self-hosted stage 4 API client', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'cookie', {configurable: true, value: '__Host-quorum_csrf=csrf-token'});
    vi.stubGlobal('crypto', {randomUUID: () => 'request-key'});
  });

  it('parses typed SSE frames and ignores heartbeat comments', () => {
    expect(parseSseFrame(': heartbeat')).toEqual({id: undefined, type: undefined});
    expect(parseSseFrame('id: 9\nevent: committee.updated\ndata: {"id":9}')).toEqual({
      id: 9, type: 'committee.updated', data: {id: 9}
    });
  });

  it('sends CSRF, revision, and idempotency headers for commands', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 201,
      json: async () => ({data: {id: 'note'}, meta: {requestId: 'one'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.createNote('committee', {content: 'Plain text'});
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/committees/committee/notes', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({
        'x-csrf-token': 'csrf-token', 'idempotency-key': 'request-key', 'content-type': 'application/json'
      }), body: JSON.stringify({content: 'Plain text'})
    }));
  });

  it('archives with CSRF and exposes only the same-origin archive download route', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'committee', status: 'ARCHIVED'}, meta: {requestId: 'archive'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.archiveCommittee('committee', 8);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/committees/committee/archive', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({baseRevision: 8}),
      headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})
    }));
    expect(selfHostedApi.committeeExportUrl('committee id')).toBe('/api/v1/committees/committee%20id/export');
  });

  it('sends exact-name committee deletion through the destructive command boundary', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 202,
      json: async () => ({data: {id: 'job', status: 'PENDING'}, meta: {requestId: 'delete'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.requestCommitteeDeletion('committee', 9, 'Security Council');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/committees/committee', expect.objectContaining({
      method: 'DELETE', credentials: 'same-origin',
      body: JSON.stringify({baseRevision: 9, confirmationName: 'Security Council'}),
      headers: expect.objectContaining({'x-csrf-token': 'csrf-token', 'idempotency-key': 'request-key'})
    }));
  });

  it('preserves stable API errors so callers can revalidate after revision conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 409,
      json: async () => ({error: {code: 'REVISION_CONFLICT', message: 'Changed.', requestId: 'two',
        details: {currentRevision: 4}}})})));
    await expect(selfHostedApi.updateNote('note', 3, {content: 'stale'})).rejects.toEqual(expect.objectContaining({
      name: 'SelfHostedApiError', status: 409, code: 'REVISION_CONFLICT', requestId: 'two', details: {currentRevision: 4}
    } satisfies Partial<SelfHostedApiError>));
  });

  it('sends a typed point ruling with an optional attendance change', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'point'}, meta: {requestId: 'point'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.resolvePoint('point', {baseRevision: 3, status: 'UPHELD', chairResponse: 'Please step out.',
      attendanceChange: {type: 'TEMPORARILY_LEFT'}});
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/points/point/resolve', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({baseRevision: 3, status: 'UPHELD',
        chairResponse: 'Please step out.', attendanceChange: {type: 'TEMPORARILY_LEFT'}}),
      headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})
    }));
  });

  it('sets an arbitrary frozen roll-call seat through the audited correction route', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'roll-call', revision: 5}, meta: {requestId: 'roll-call'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.setRollCallResponse('roll-call', 4, 'seat-two', 'PRESENT');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/roll-calls/roll-call/set-response', expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      body: JSON.stringify({baseRevision: 4, seatId: 'seat-two', response: 'PRESENT'}),
      headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})
    }));
  });

  it('withdraws a pending motion with its loaded revision', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'motion', status: 'WITHDRAWN'}, meta: {requestId: 'motion'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.withdrawMotion('motion', 4);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/motions/motion/withdraw', expect.objectContaining({method: 'POST',
      body: JSON.stringify({baseRevision: 4}), headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})}));
  });

  it('sets or retracts a represented seat vote with the loaded ballot revision', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'ballot', revision: 5}, meta: {requestId: 'vote'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.setBallotVote('ballot', 4, null, 'seat-two');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/ballots/ballot/set-vote', expect.objectContaining({method: 'POST',
      body: JSON.stringify({baseRevision: 4, choice: null, onBehalfOfSeatId: 'seat-two'}),
      headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})}));
  });

  it('sets legacy direct motion votes without opening a formal ballot', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'motion'}, meta: {requestId: 'direct-vote'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.setMotionDirectVote('motion', 'FOR', 'seat-two');
    await selfHostedApi.setMotionDirectVoteSettings('motion', 2, false);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/motions/motion/direct-vote', expect.objectContaining({
      method: 'POST', body: JSON.stringify({choice: 'FOR', onBehalfOfSeatId: 'seat-two'})}));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/motions/motion/direct-vote-settings', expect.objectContaining({
      method: 'POST', body: JSON.stringify({baseRevision: 2, includeNonVotingSeats: false})}));
  });

  it('sends legacy speaker workspace changes through audited self-hosted commands', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'list'}, meta: {requestId: 'speaker'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.updateSpeakerList('list', 2, {name: '主发言名单', delegatesCanQueue: true});
    await selfHostedApi.joinSpeakerQueue('list', 'seat', 'FOR');
    await selfHostedApi.removeSpeakerQueueEntry('list', 'entry', 3);
    await selfHostedApi.setSpeakerListStatus('list', 4, 'CLOSED');
    await selfHostedApi.yieldSpeech('speech', 5, 'QUESTIONS', 'questioner');
    await selfHostedApi.decideSpeechYield('speech', 6, 'ACCEPT');
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(call => call[0])).toEqual([
      '/api/v1/speaker-lists/list/settings',
      '/api/v1/speaker-lists/list/queue',
      '/api/v1/speaker-lists/list/queue/entry/remove',
      '/api/v1/speaker-lists/list/status',
      '/api/v1/speeches/speech/yield',
      '/api/v1/speeches/speech/yield-decision'
    ]);
    expect(calls[0]?.[1].body).toBe(JSON.stringify({baseRevision: 2, name: '主发言名单', delegatesCanQueue: true}));
    expect(calls[1]?.[1].body).toBe(JSON.stringify({seatId: 'seat', stance: 'FOR'}));
    expect(calls[4]?.[1].body).toBe(JSON.stringify({baseRevision: 5, type: 'QUESTIONS', targetSeatId: 'questioner'}));
    expect(calls[5]?.[1].body).toBe(JSON.stringify({baseRevision: 6, decision: 'ACCEPT'}));
  });

  it('keeps the Chair proposer and initial seconder in one motion command', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 201,
      json: async () => ({data: {id: 'motion', status: 'SECONDED'}, meta: {requestId: 'motion'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.proposeMotion('committee', {meetingSessionId: 'meeting', motionTypeId: 'introduce-draft-resolution',
      onBehalfOfSeatId: 'proposer', secondedBySeatId: 'seconder', parameters: {proposal: 'A/RES/1'}});
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/committees/committee/motions', expect.objectContaining({method: 'POST',
      body: JSON.stringify({meetingSessionId: 'meeting', motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: 'proposer', secondedBySeatId: 'seconder', parameters: {proposal: 'A/RES/1'}}),
      headers: expect.objectContaining({'x-csrf-token': 'csrf-token', 'idempotency-key': expect.any(String)})}));
  });

  it('adapts existing Chair, assignment, invitation, mode, status, and rule routes', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {}, meta: {requestId: 'adapter'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.revokeChair('committee', 'chair@example.com', 2);
    await selfHostedApi.endSeatAssignment('committee', 'assignment');
    await selfHostedApi.createSeatInvitation('committee', {seatId: 'seat', maxUses: 1, expiresAt: '2026-08-14T12:00:00.000Z'});
    await selfHostedApi.setOperationMode('committee', 'CHAIR_OPERATED', 3);
    await selfHostedApi.setLayoutSettings('committee', {moveQueueUp: true, timersInSeparateColumns: false}, 4);
    await selfHostedApi.setCommitteeStatus('committee', 'PAUSED', 4);
    await selfHostedApi.listRulePackages();
    await selfHostedApi.activateRules('committee', 'version', 5);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(call => call[0])).toEqual([
      '/api/v1/committees/committee/chairs',
      '/api/v1/committees/committee/seat-assignments',
      '/api/v1/committees/committee/seat-invitations',
      '/api/v1/committees/committee/operation-mode',
      '/api/v1/committees/committee/layout-settings',
      '/api/v1/committees/committee/status',
      '/api/v1/rule-packages',
      '/api/v1/committees/committee/rules/activate'
    ]);
    expect(calls[0]?.[1]).toEqual(expect.objectContaining({method: 'DELETE', body: JSON.stringify({email: 'chair@example.com', baseRevision: 2})}));
    expect(calls[1]?.[1]).toEqual(expect.objectContaining({method: 'POST',
      body: JSON.stringify({action: 'END', assignmentId: 'assignment'})}));
    expect(calls[4]?.[1]).toEqual(expect.objectContaining({method: 'POST',
      body: JSON.stringify({settings: {moveQueueUp: true, timersInSeparateColumns: false}, baseRevision: 4})}));
    expect(calls[5]?.[1]).toEqual(expect.objectContaining({method: 'POST',
      body: JSON.stringify({status: 'PAUSED', baseRevision: 4})}));
    expect(calls[7]?.[1]).toEqual(expect.objectContaining({method: 'POST',
      body: JSON.stringify({rulePackageVersionId: 'version', baseRevision: 5})}));
  });

  it('sends file revisions and stable idempotency keys and exposes only the attachment route', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'file', status: 'PENDING_REVIEW'}, meta: {requestId: 'file-request'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.submitFileForReview('file', 7, 'review-key');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/files/file/submit-review', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({baseRevision: 7}),
      headers: expect.objectContaining({'x-csrf-token': 'csrf-token', 'idempotency-key': 'review-key'})
    }));
    expect(selfHostedApi.fileDownloadUrl('file id')).toBe('/api/v1/files/file%20id/download');
  });

  it('replays a caller-provided upload creation key unchanged', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 201,
      json: async () => ({data: {id: 'upload', status: 'CREATED'}, meta: {requestId: 'upload'}})}));
    vi.stubGlobal('fetch', fetchMock);
    const input = {logicalName: '工作文件', originalName: 'paper.pdf', mediaType: 'application/pdf',
      expectedSizeBytes: 3, sha256: 'a'.repeat(64)};
    await selfHostedApi.createFileUpload('committee', input, 'same-upload-key');
    await selfHostedApi.createFileUpload('committee', input, 'same-upload-key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[1].headers).toEqual(expect.objectContaining({'idempotency-key': 'same-upload-key'}));
    }
  });

  it('keeps Chair host pairing and revocation on CSRF-protected committee commands', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {}, meta: {requestId: 'agent'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.createStoragePairingCode('committee', 4, 'TRANSFER');
    await selfHostedApi.revokeStorageHost('committee', 'host', 5);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/v1/committees/committee/storage-agent/pairing-codes',
      expect.objectContaining({method: 'POST', body: JSON.stringify({baseRevision: 4, purpose: 'TRANSFER'}),
        headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})})]);
    expect(fetchMock.mock.calls[1]).toEqual(['/api/v1/committees/committee/storage-hosts/host/revoke',
      expect.objectContaining({method: 'POST', body: JSON.stringify({baseRevision: 5}),
        headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})})]);
  });

  it('sends a fenced and idempotent Chair conflict decision', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'conflict', status: 'RESOLVED'}, meta: {requestId: 'conflict'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.resolveStorageAgentConflict('committee', 'conflict', {baseRevision: 1,
      leaseGeneration: 7, fileRevision: 3, action: 'ACCEPT_LOCAL'}, 'resolution-key');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/committees/committee/storage-agent-conflicts/conflict/resolve', expect.objectContaining({
        method: 'POST', body: JSON.stringify({baseRevision: 1, leaseGeneration: 7, fileRevision: 3,
          action: 'ACCEPT_LOCAL'}), headers: expect.objectContaining({'x-csrf-token': 'csrf-token',
          'idempotency-key': 'resolution-key'})
      }));
  });

  it('streams a File through XHR with Cookie credentials, CSRF, progress, cancellation support, and a caller key', async () => {
    class FakeRequest {
      static latest: FakeRequest;
      readonly upload: {onprogress?: (event: ProgressEvent) => void} = {};
      readonly headers = new Map<string, string>();
      withCredentials = false; status = 0; responseText = ''; body?: Document | XMLHttpRequestBodyInit | null;
      method = ''; url = '';
      onload?: () => void; onerror?: () => void; onabort?: () => void;
      constructor() { FakeRequest.latest = this; }
      open(method: string, url: string): void { this.method = method; this.url = url; }
      setRequestHeader(name: string, value: string): void { this.headers.set(name, value); }
      send(body?: Document | XMLHttpRequestBodyInit | null): void {
        this.body = body; this.upload.onprogress?.({loaded: 3, total: 3, lengthComputable: true} as ProgressEvent);
        this.status = 200; this.responseText = JSON.stringify({data: {id: 'upload', status: 'STAGED'},
          meta: {requestId: 'upload-request'}}); this.onload?.();
      }
      abort(): void { this.onabort?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    const progress = vi.fn(); const file = new File(['abc'], 'paper.txt', {type: 'text/plain'});
    await expect(selfHostedApi.uploadFileContent('upload', file, 'content-key', {onProgress: progress}))
      .resolves.toEqual(expect.objectContaining({status: 'STAGED'}));
    expect(FakeRequest.latest.withCredentials).toBe(true);
    expect(FakeRequest.latest.headers).toEqual(new Map([
      ['x-csrf-token', 'csrf-token'], ['idempotency-key', 'content-key']
    ]));
    expect(FakeRequest.latest.body).toBe(file);
    expect(progress.mock.calls).toEqual([[0, 3], [3, 3]]);
  });
});
