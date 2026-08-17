// @vitest-environment node

import type {FileEntry} from '@quorum/contracts';
import {describe, expect, it} from 'vitest';
import {safeDownloadHeaders} from './file-service';

function file(originalName: string, mediaType: string): FileEntry {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    committeeId: '20000000-0000-4000-8000-000000000001',
    logicalName: '工作文件',
    mediaType,
    status: 'PUBLISHED',
    createdByUserId: '30000000-0000-4000-8000-000000000001',
    currentVersion: {
      id: '40000000-0000-4000-8000-000000000001',
      versionNumber: 1,
      originalName,
      mediaType,
      sizeBytes: 42,
      sha256: 'a'.repeat(64),
      blobId: '50000000-0000-4000-8000-000000000001',
      createdAt: '2026-08-13T00:00:00.000Z'
    },
    revision: 3,
    submittedAt: '2026-08-13T00:01:00.000Z',
    publishedAt: '2026-08-13T00:02:00.000Z',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:02:00.000Z'
  };
}

describe('safe file download headers', () => {
  it.each(['text/html', 'text/html; charset=utf-8', 'text/xml', 'application/xhtml+xml',
    'application/javascript', 'text/javascript', 'image/svg+xml'])('forces %s to download as opaque bytes', mediaType => {
    const headers = safeDownloadHeaders(file('../../恶意\r\nX-Injected: yes.svg', mediaType));
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(headers['content-disposition']).toMatch(/^attachment; filename="download\.svg";/);
    expect(headers['content-disposition']).toContain("filename*=UTF-8''..%2F..%2F%E6%81%B6%E6%84%8F%0D%0AX-Injected%3A%20yes.svg");
    expect(headers['content-disposition']).not.toMatch(/[\r\n]/);
    expect(headers).toEqual(expect.objectContaining({
      'content-length': '42',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, no-store'
    }));
  });

  it('preserves a non-executable media type while still forcing attachment download', () => {
    const headers = safeDownloadHeaders(file('议题材料.PDF', 'application/pdf'));
    expect(headers['content-type']).toBe('application/pdf');
    expect(headers['content-disposition']).toMatch(/^attachment; filename="download\.pdf";/);
    expect(headers['content-disposition']).toContain('%E8%AE%AE%E9%A2%98%E6%9D%90%E6%96%99.PDF');
  });

  it('falls back safely for malformed media types and Unicode filenames', () => {
    const headers = safeDownloadHeaders(file(`broken-\uD800.svg`, 'image/png\r\nX-Injected: yes'));
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(headers['content-disposition']).not.toMatch(/[\r\n]/);
    expect(headers['content-disposition']).toContain('broken-%EF%BF%BD.svg');
  });
});
