import {createHash} from 'node:crypto';
import {pinyin} from 'pinyin-pro';
import {normalizeSearchTerm, type LocalizedNames} from '@quorum/contracts';

const ENGLISH_STOP_WORDS = new Set(['a', 'an', 'and', 'of', 'the']);
const ENGLISH_ABBREVIATIONS: Record<string, string> = {
  'economic and social council': 'ECOSOC'
};

// Bump on any change to the generators or their checked-in dictionaries.
export const SEARCH_ALGORITHM_VERSION = `1:pinyin-pro-3.29.4:icu-${process.versions.icu ?? 'unknown'}`;

export function generatedTerms(names: LocalizedNames, builtinCode?: string): string[] {
  const terms = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeSearchTerm(value);
    if (normalized) terms.add(normalized);
  };
  for (const [language, value] of Object.entries(names)) {
    const name = value.trim();
    if (!name) continue;
    add(name);
    if (language.startsWith('zh')) {
      const initials = pinyin(name, {pattern: 'first', toneType: 'none', type: 'array', nonZh: 'removed'}).join('');
      add(initials);
    }
    if (language.startsWith('en')) {
      const words = name.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];
      add(ENGLISH_ABBREVIATIONS[words.join(' ')] ?? words.filter(word => !ENGLISH_STOP_WORDS.has(word))
        .map(word => word[0]).join(''));
    }
  }
  if (builtinCode) add(builtinCode);
  return [...terms];
}

export function searchSourceHash(names: LocalizedNames, builtinCode?: string): string {
  return createHash('sha256').update(JSON.stringify([Object.entries(names).sort(([a], [b]) => a.localeCompare(b)), builtinCode ?? null,
    SEARCH_ALGORITHM_VERSION])).digest('hex');
}
