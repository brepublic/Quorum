// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {isAllowedDelegateFile} from '@quorum/contracts';
import {rejectionTypes, allowedExtensions} from './settings';

describe('delegate file settings validation', () => {
  it('checks the final extension case-insensitively without trusting a MIME type', () => {
    for (const name of ['草案.PDF', 'my.final.docx']) expect(isAllowedDelegateFile(name, ['pdf', 'docx'])).toBe(true);
    for (const name of ['a.pdf.exe', 'a.mp4', 'pdf', 'a.pdf.', 'a.pdf ']) expect(isAllowedDelegateFile(name, ['pdf', 'docx'])).toBe(false);
  });
  it('requires unique options and messages except for custom input', () => {
    const preset = {id: 'format', label: {'zh-CN': '格式'}, message: {'zh-CN': '请修改'}, custom: false};
    expect(() => rejectionTypes([preset], 'en')).toThrow();
    expect(rejectionTypes([preset], 'zh-CN')).toHaveLength(1);
    expect(rejectionTypes([preset, {id: 'other', label: {'zh-CN': '其他'}, message: {}, custom: true}])).toHaveLength(2);
    for (const rows of [[], [preset, preset], [{...preset, message: {}}], [{...preset, custom: 'true'}]]) {
      expect(() => rejectionTypes(rows)).toThrow();
    }
  });
  it('requires all three format lists and rejects wildcards and paths', () => {
    const value = {WORKING_PAPER: ['pdf'], DIRECTIVE_DRAFT: ['doc'], RESOLUTION_DRAFT: ['docx']};
    expect(allowedExtensions(value)).toEqual(value);
    for (const list of [[], ['*'], ['../pdf'], ['pdf,doc'], ['.pdf']]) {
      expect(() => allowedExtensions({...value, WORKING_PAPER: list})).toThrow();
    }
    expect(() => allowedExtensions({WORKING_PAPER: ['pdf']})).toThrow();
  });
});
