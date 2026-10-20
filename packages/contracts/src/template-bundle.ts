import type {CommitteeTemplateInput, CountryTemplateInput} from './stage4.js';

// A committee package can contain two templates, each accepted by the 8 MiB editor API.
export const TEMPLATE_BUNDLE_MAX_BYTES = 20 * 1024 * 1024;

export type TemplateBundle =
  | {format: 'quorum-template'; version: 1; kind: 'country'; countryTemplate: CountryTemplateInput}
  | {format: 'quorum-template'; version: 1; kind: 'committee';
    committeeTemplate: Omit<CommitteeTemplateInput, 'countryTemplateKey'> & {
      countryTemplateKey: 'builtin:default' | 'bundled';
    };
    countryTemplate: CountryTemplateInput | null};

export interface TemplateImportResult {
  countryTemplateId: string | null;
  committeeTemplateId: string | null;
}
