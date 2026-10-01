import {describe, expect, it} from 'vitest';
import {formatApiError} from './error-localization';

describe('structured error localization', () => {
  it('uses the same proceedings terminology as the workspace', () => {
    expect(formatApiError({reason: 'SPEAKER_LIST_CLOSED'}, 'en'))
      .toBe("The Speaker's List is closed. Open it first.");
    expect(formatApiError({reason: 'INVALID_DRAFT_TYPE'}, 'en'))
      .toBe('Choose a Draft Resolution or Draft Directive.');
    expect(formatApiError({reason: 'SPEAKER_LIST_CLOSED'}, 'zh-CN'))
      .toBe('发言名单已关闭，请先开放名单。');
  });
  it('uses the reason and current language without displaying server message text', () => {
    const failure = {code: 'FORBIDDEN', message: '/private/path access token=secret',
      localization: {reason: 'INCORRECT_PASSWORD'}};
    expect(formatApiError(failure, 'en')).toBe('Password is incorrect.');
    expect(formatApiError(failure, 'zh-CN')).toBe('密码不正确。');
    expect(formatApiError(new Error('/private/path token=secret'), 'en')).toBe('Request failed. Try again later.');
    expect(formatApiError({code: 'NEW_SERVER_CODE', message: 'secret'}, 'zh-CN')).toBe('请求失败，请稍后重试。');
  });
  it('includes a bounded request ID for unknown failures', () => {
    expect(formatApiError({code: 'NEW_CODE', requestId: 'req-123'}, 'en')).toContain('Request ID: req-123');
    expect(formatApiError({code: 'NEW_CODE', requestId: '/private/token'}, 'en')).not.toContain('/private');
  });
  it('accepts only bounded extension parameters', () => {
    expect(formatApiError({reason: 'INVALID_FILE_EXTENSION', params: {formats: '.pdf, .docx'}}, 'en'))
      .toBe('Allowed file formats: .pdf, .docx');
    expect(formatApiError({reason: 'INVALID_FILE_EXTENSION', params: {formats: '/private/path'}}, 'zh-CN'))
      .toBe('允许的文件格式：—');
  });
  it.each([
    [400, 'BAD_REQUEST'], [401, 'AUTHENTICATION_REQUIRED'], [403, 'FORBIDDEN'], [404, 'API_ROUTE_NOT_FOUND'], [405, 'METHOD_NOT_ALLOWED'],
    [408, 'REQUEST_TIMEOUT'], [429, 'RATE_LIMITED'], [500, 'INTERNAL_ERROR'],
    [502, 'SERVICE_NOT_READY'], [503, 'SERVICE_NOT_READY'], [504, 'REQUEST_TIMEOUT']
  ])('explains a non-JSON HTTP %s response using its status', (status, reason) => {
    for (const language of ['en', 'zh-CN'] as const) {
      for (const code of ['INVALID_RESPONSE', 'HTTP_ERROR']) {
        expect(formatApiError({status, code, message: 'private proxy diagnostics'}, language))
          .toBe(formatApiError({reason}, language));
      }
    }
  });
  it('keeps a specific service reason and distinguishes content absence from a missing interface', () => {
    expect(formatApiError({status: 503, code: 'INVALID_RESPONSE', reason: 'STORAGE_AGENT_OFFLINE'}, 'en'))
      .toBe(formatApiError({reason: 'STORAGE_AGENT_OFFLINE'}, 'en'));
    expect(formatApiError({status: 404, code: 'NOT_FOUND'}, 'zh-CN')).toBe('内容不存在，或当前账号无权查看。');
    expect(formatApiError({code: 'NOT_FOUND', reason: 'API_ROUTE_NOT_FOUND'}, 'zh-CN')).toContain('部署版本和配置');
    expect(formatApiError({status: 200, code: 'INVALID_RESPONSE'}, 'en')).toContain('invalid response');
  });
});

it('explains business conflicts and download blockers in both languages without exposing diagnostics', () => {
  for (const reason of ['VOTE_ALREADY_RECORDED', 'SPEAKER_LIST_CLOSED', 'TIMER_EXHAUSTED', 'REQUIRED_VOTES_MISSING',
    'FILE_NOT_PENDING_REVIEW', 'STORAGE_AGENT_OFFLINE', 'STORAGE_AGENT_SOURCE_MISSING', 'STORAGE_CACHE_CAPACITY_UNAVAILABLE']) {
    for (const language of ['en', 'zh-CN'] as const) {
      const text = formatApiError({code: 'RESOURCE_CONFLICT', reason, message: 'secret /private/file'}, language);
      expect(text).not.toMatch(/secret|private|current state|当前状态|请求失败/);
      expect(text.length).toBeGreaterThan(10);
    }
  }
  expect(formatApiError({code: 'RESOURCE_CONFLICT', reason: 'VOTE_ALREADY_RECORDED'}, 'zh-CN'))
    .toBe('该席位的相同投票已记录，请刷新查看结果。');
});

it('bounds numeric validation parameters instead of displaying arbitrary server values', () => {
  expect(formatApiError({reason: 'REQUIRED_TEXT', params: {max: 200}}, 'zh-CN')).toContain('200');
  for (const max of ['/private/secret', -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, {}]) {
    expect(formatApiError({reason: 'REQUIRED_TEXT', params: {max}}, 'en'))
      .toBe('Enter non-empty text, up to — characters.');
  }
});
