import type {RulePackageDefinition} from './index.js';

export interface RuleTranslationIssue {language: 'zh-CN' | 'en'; path: string}

/** Call after schema validation. Missing content cannot be covered by a language declaration. */
export function ruleLanguageAvailability(definition: RulePackageDefinition): {
  supportedLanguages: Array<'zh-CN' | 'en'>;
  missing: RuleTranslationIssue[];
} {
  const languages = ['zh-CN', 'en'] as const;
  const missing: RuleTranslationIssue[] = [];
  function names(value: unknown, path: string) {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    for (const language of languages) {
      const value = record[language];
      if (typeof value !== 'string' || !value.trim()) missing.push({language, path: `${path}.${language}`});
    }
  }
  function optionalLabels(value: unknown, path: string) {
    if (Array.isArray(value)) {value.forEach((child, index) => optionalLabels(child, `${path}.${index}`)); return;}
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['names', 'description', 'label', 'labels'].includes(key)) names(child, `${path}.${key}`);
      else optionalLabels(child, `${path}.${key}`);
    }
  }
  names(definition.metadata.names, 'metadata.names');
  if (definition.metadata.description !== undefined) names(definition.metadata.description, 'metadata.description');
  for (const section of ['phases', 'points', 'motions'] as const) {
    definition[section].forEach((item, index) => {
      const {names: itemNames, ...rest} = item;
      names(itemNames, `${section}.${index}.names`);
      optionalLabels(rest, `${section}.${index}`);
    });
  }
  for (const section of ['meeting', 'attendance', 'speakerLists', 'ballots', 'documents'] as const) {
    optionalLabels(definition[section], section);
  }
  for (const [key, value] of Object.entries(definition.terminology)) names(value, `terminology.${key}`);
  return {supportedLanguages: languages.filter(language => !missing.some(issue => issue.language === language)), missing};
}
