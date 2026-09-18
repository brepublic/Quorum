import {CONTENT_LANGUAGES, type ContentLanguage, type LocalizedNames, DELEGATE_FILE_TYPES, type DelegateFileSettings, type FileRejectionType} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';

function invalid(message: string): never { throw new AppError({code: 'VALIDATION_FAILED', message}); }
export function rejectionTypes(value: unknown, language?: ContentLanguage): FileRejectionType[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) return invalid('Set 1–30 rejection types.');
  const ids = new Set<string>();
  const labels = new Map(CONTENT_LANGUAGES.map(item => [item, new Set<string>()]));
  const translations = (value: unknown, limit: number, field: string, required: boolean): LocalizedNames => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Invalid rejection translations.');
    const result: LocalizedNames = {};
    for (const [key, text] of Object.entries(value)) {
      if (!CONTENT_LANGUAGES.includes(key as ContentLanguage) || typeof text !== 'string' || text.trim().length > limit) {
        return invalid('Invalid rejection translations.');
      }
      if (text.trim()) result[key] = text.trim();
    }
    if (required && !Object.keys(result).length) return invalid('Enter a rejection label and message.');
    if (required && language && !result[language]) throw new AppError({code: 'VALIDATION_FAILED',
      reason: 'MISSING_CONTENT_TRANSLATION', message: 'Rejection settings are missing a committee translation.',
      params: {language}, fieldErrors: [{field, reason: 'MISSING_CONTENT_TRANSLATION', params: {language}}]});
    return result;
  };
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      || typeof item.custom !== 'boolean') return invalid('Invalid rejection type.');
    if (ids.has(item.id)) return invalid('Rejection types must be unique.');
    ids.add(item.id);
    const label = translations(item.label, 100, `rejectionTypes.${index}.label`, true);
    const message = item.custom ? {} : translations(item.message, 2000, `rejectionTypes.${index}.message`, true);
    for (const language of CONTENT_LANGUAGES) {
      const text = label[language];
      if (text && labels.get(language)!.has(text)) return invalid('Rejection types must be unique.');
      if (text) labels.get(language)!.add(text);
    }
    return {id: item.id, label, message, custom: item.custom};
  });
}
export function allowedExtensions(value: unknown): DelegateFileSettings['allowedExtensions'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('请设置每种文件类型允许的后缀名。');
  return Object.fromEntries(DELEGATE_FILE_TYPES.map(type => {
    const list = (value as Record<string, unknown>)[type];
    if (!Array.isArray(list) || !list.length || list.length > 50
      || list.some(ext => typeof ext !== 'string' || !/^[a-z0-9]{1,16}$/.test(ext))) {
      return invalid('每种文件类型至少需要一个后缀名，仅支持英文字母和数字。');
    }
    return [type, [...new Set(list)]];
  })) as DelegateFileSettings['allowedExtensions'];
}
