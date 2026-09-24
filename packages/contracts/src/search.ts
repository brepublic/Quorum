/** Search-only labels; these never identify the selected business object. */
export function normalizeSearchTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').replace(/[\s\p{P}\p{S}]+/gu, '');
}

export interface SearchableOption {
  searchTerms?: string[];
  text?: string;
}

export function searchOptions<T extends SearchableOption>(options: T[], query: string): T[] {
  const needle = normalizeSearchTerm(query);
  if (!needle) return options;
  const score = (option: T): number => {
    const terms = [option.text ?? '', ...(option.searchTerms ?? [])].map(normalizeSearchTerm);
    if (terms.some(term => term === needle)) return 0;
    if (terms.some(term => term.startsWith(needle))) return 1;
    if (terms.some(term => term.includes(needle))) return 2;
    return 3;
  };
  return options.map((option, index) => ({option, index, score: score(option)}))
    .filter(item => item.score < 3)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(item => item.option);
}
