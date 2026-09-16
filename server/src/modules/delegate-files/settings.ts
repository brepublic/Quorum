import {DELEGATE_FILE_TYPES, type DelegateFileSettings, type FileRejectionType} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';

function invalid(message: string): never { throw new AppError({code: 'VALIDATION_FAILED', message}); }
export function rejectionTypes(value: unknown): FileRejectionType[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) return invalid('请设置 1–30 个驳回类型。');
  const ids = new Set<string>(); const labels = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 100
      || typeof item.message !== 'string' || item.message.trim().length > 2000 || typeof item.custom !== 'boolean'
      || (!item.custom && !item.message.trim())) return invalid('请填写类型名称和代表端提示消息。');
    if (ids.has(item.id) || labels.has(item.label.trim())) return invalid('驳回类型不能重复。');
    ids.add(item.id); labels.add(item.label.trim());
    return {id: item.id, label: item.label.trim(), message: item.custom ? '' : item.message.trim(), custom: item.custom};
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
