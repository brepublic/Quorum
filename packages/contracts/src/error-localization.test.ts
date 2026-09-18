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
