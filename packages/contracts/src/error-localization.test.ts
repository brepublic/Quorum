import {describe, expect, it} from 'vitest';
import {formatApiError} from './error-localization';

describe('structured error localization', () => {
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
});

it('explains business conflicts and download blockers in both languages without exposing diagnostics', () => {
  for (const reason of ['VOTE_ALREADY_RECORDED', 'SPEAKER_LIST_CLOSED', 'TIMER_EXHAUSTED', 'CAUCUS_TIMER_FIXED',
    'CAUCUS_MUST_END_NATURALLY', 'REQUIRED_VOTES_MISSING',
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
