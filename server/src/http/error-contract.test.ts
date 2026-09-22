// @vitest-environment node
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {ERROR_TEXT, formatApiError} from '@quorum/contracts';
import {AppError, normalizeError} from './errors';
import {validateCountryTemplate} from '../modules/stage4/validation';
import {ProviderStorageError} from '../modules/storage/server-volume';
import {UploadStreamError} from '../modules/storage/staging';

function sources(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory()
    ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.includes('.test.')
      ? [join(directory, entry.name)] : []);
}

describe('actionable error contract', () => {
  it('requires an explicit reason for recoverable server errors', () => {
    const missing: string[] = [];
    for (const file of sources(fileURLToPath(new URL('../', import.meta.url)))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isNewExpression(node) && node.expression.getText(source) === 'AppError') {
          const argument = node.arguments?.[0];
          if (argument && ts.isObjectLiteralExpression(argument)) {
            const code = argument.properties.find(item => item.name?.getText(source) === 'code');
            const reason = argument.properties.some(item => item.name?.getText(source) === 'reason');
            if (code && ts.isPropertyAssignment(code) && ts.isStringLiteral(code.initializer)
              && ['RESOURCE_CONFLICT', 'VALIDATION_FAILED', 'BAD_REQUEST', 'FORBIDDEN', 'SERVICE_NOT_READY'].includes(code.initializer.text)
              && !reason) missing.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(missing).toEqual([]);
  });

  it('preserves validation constraints through nested field paths', () => {
    try {
      validateCountryTemplate({names: {en: 'x'.repeat(201)}, defaultLanguage: 'en', countryLanguages: ['en'], countries: []});
      expect.fail('Expected invalid name');
    } catch (error) {
      const body = normalizeError(error, 'name-check').body.error;
      expect(body).toMatchObject({code: 'VALIDATION_FAILED', reason: 'REQUIRED_TEXT', params: {max: 200},
        fieldErrors: [{field: 'names.en', reason: 'REQUIRED_TEXT', params: {max: 200}}]});
      expect(formatApiError(body, 'zh-CN')).toContain('200');
    }
  });

  it('keeps safe provider reasons while redacting unrecognized internal failures', () => {
    const failure = new ProviderStorageError('S3_WRITE_FAILED', 'SERVICE_NOT_READY', '/secret/key');
    const body = normalizeError(new AppError({code: failure.apiCode, reason: failure.reason,
      message: ERROR_TEXT[failure.reason].en, expose: true, cause: failure}), 'req-storage').body.error;
    expect(body).toMatchObject({code: 'SERVICE_NOT_READY', reason: 'S3_WRITE_FAILED'});
    expect(JSON.stringify(body)).not.toContain('/secret');
    expect(formatApiError(body, 'zh-CN')).toContain('存储桶写入权限');
    expect(new UploadStreamError('UPLOAD_HASH_MISMATCH', 'VALIDATION_FAILED', 'diagnostic', 10).reason)
      .toBe('UPLOAD_HASH_MISMATCH');
    const unknown = normalizeError(new Error('/secret/path'), 'req-unknown').body.error;
    expect(unknown.reason).toBeUndefined();
    expect(unknown.message).not.toContain('/secret');
  });
});
