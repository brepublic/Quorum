import type {
  ApiErrorReason,
  ApiErrorParams,
  CommitteeTemplateInput,
  CountryTemplateInput,
  FlagSnapshot,
  LocalizedNames,
  SeatRank
} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';

const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const STABLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RANKS = new Set<SeatRank>(['STANDARD', 'NGO', 'OBSERVER']);
const FLAG_DATA_PREFIX = 'data:image/webp;base64,';
const MAX_FLAG_BYTES = 256 * 1024;

function invalid(reason: ApiErrorReason, message: string, field?: string, params?: ApiErrorParams): never {
  throw new AppError({code: 'VALIDATION_FAILED', reason, message, params,
    ...(field ? {fieldErrors: [{field, reason, params}]} : {})});
}

function atField<T>(field: string, validate: () => T): T {
  try { return validate(); } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'VALIDATION_FAILED') throw error;
    throw new AppError({code: error.code, reason: error.reason, message: error.message, params: error.params,
      fieldErrors: error.fieldErrors?.map(item => ({...item, field: `${field}.${item.field}`}))
        ?? [{field, reason: error.reason ?? 'INVALID_FIELD', params: error.params}]});
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('INVALID_OBJECT', `${name} is invalid.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid('UNSUPPORTED_FIELDS', `${name} contains an unsupported field.`);
}

function string(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim().length === 0)) {
    invalid(allowEmpty ? 'INVALID_TEXT' : 'REQUIRED_TEXT', `${name} is invalid.`, undefined, {max});
  }
  return allowEmpty ? value : value.trim();
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) invalid('INVALID_INTEGER', `${name} is invalid.`);
  return Number(value);
}

export function validateLocalizedNames(value: unknown, defaultLanguage: unknown): {
  names: LocalizedNames; defaultLanguage: string;
} {
  const language = string(defaultLanguage, 'Default language', 35);
  if (!LANGUAGE.test(language)) invalid('INVALID_LANGUAGE_TAG', 'Default language is invalid.');
  const raw = object(value, 'Names');
  const names: LocalizedNames = {};
  for (const [key, candidate] of Object.entries(raw)) {
    if (!LANGUAGE.test(key)) invalid('INVALID_LANGUAGE_TAG', 'Name language is invalid.');
    const name = atField(`names.${key}`, () => string(candidate, 'Localized name', 200));
    names[key] = name;
  }
  if (Object.keys(names).length === 0 || !names[defaultLanguage as string]) {
    throw new AppError({code: 'VALIDATION_FAILED', reason: 'MISSING_CONTENT_TRANSLATION',
      message: 'Names must include the default language.',
      fieldErrors: [{field: `names.${language}`, reason: 'MISSING_CONTENT_TRANSLATION'}]});
  }
  return {names, defaultLanguage: language};
}

function uint24(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

export function webpDimensions(buffer: Buffer): {width: number; height: number} {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WEBP') invalid('INVALID_WEBP_FLAG', 'Flag image must be a valid WebP image.');
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return {width: uint24(buffer, 24) + 1, height: uint24(buffer, 27) + 1};
  if (chunk === 'VP8L' && buffer[20] === 0x2f) {
    return {
      width: (buffer[21]! | ((buffer[22]! & 0x3f) << 8)) + 1,
      height: ((buffer[22]! >> 6) | (buffer[23]! << 2) | ((buffer[24]! & 0x0f) << 10)) + 1
    };
  }
  if (chunk === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff};
  }
  invalid('INVALID_WEBP_FLAG', 'Flag image must be a valid WebP image.');
}

export function validateFlag(value: unknown): FlagSnapshot {
  const raw = object(value, 'Flag');
  exactKeys(raw, ['type', 'value'], 'Flag');
  const type = raw.type;
  if (type === 'STANDARD') {
    const code = string(raw.value, 'Standard flag code', 2).toLowerCase();
    if (!/^[a-z]{2}$/.test(code)) invalid('INVALID_STANDARD_FLAG', 'Standard flag code is invalid.');
    return {type, value: code};
  }
  if (type === 'EMOJI') {
    const emoji = string(raw.value, 'Flag emoji', 32);
    if (Buffer.byteLength(emoji, 'utf8') > 32) invalid('FLAG_EMOJI_TOO_LONG', 'Flag emoji is too large.');
    return {type, value: emoji};
  }
  if (type === 'IMAGE') {
    const data = string(raw.value, 'Flag image', 400000);
    if (!data.startsWith(FLAG_DATA_PREFIX)) invalid('INVALID_WEBP_FLAG', 'Flag image must be WebP data.');
    const encoded = data.slice(FLAG_DATA_PREFIX.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid('INVALID_WEBP_FLAG', 'Flag image encoding is invalid.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_FLAG_BYTES
      || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      invalid('FLAG_IMAGE_TOO_LARGE', 'Flag image encoding is invalid or too large.');
    }
    const dimensions = webpDimensions(bytes);
    if (dimensions.width > 256 || dimensions.height > 160 || dimensions.width < 1 || dimensions.height < 1) {
      invalid('FLAG_DIMENSIONS_INVALID', 'Flag image dimensions exceed 256 by 160 pixels.');
    }
    return {type, value: data};
  }
  invalid('INVALID_FLAG_TYPE', 'Flag type is invalid.');
}

export function validateCountryTemplate(value: unknown): CountryTemplateInput {
  const raw = object(value, 'Country template');
  exactKeys(raw, ['names', 'defaultLanguage', 'countryLanguages', 'countries'], 'Country template');
  const localized = validateLocalizedNames(raw.names, raw.defaultLanguage);
  if (!Array.isArray(raw.countryLanguages) || raw.countryLanguages.length < 1 || raw.countryLanguages.length > 32) {
    invalid('INVALID_COUNTRY_LANGUAGES', 'Country languages are invalid.');
  }
  const countryLanguages = [...new Set(raw.countryLanguages.map(item => string(item, 'Country language', 35)))];
  if (countryLanguages.length !== raw.countryLanguages.length
    || countryLanguages.some(language => !LANGUAGE.test(language))
    || !countryLanguages.includes(localized.defaultLanguage)) invalid('INVALID_COUNTRY_LANGUAGES', 'Country languages are invalid.');
  if (!Array.isArray(raw.countries) || raw.countries.length > 512) {
    invalid('TOO_MANY_COUNTRIES', 'Countries are invalid.');
  }
  const stableKeys = new Set<string>();
  const countries = raw.countries.map((candidate, index) => atField(`countries.${index}`, () => {
    const country = object(candidate, `Country ${index + 1}`);
    exactKeys(country, ['stableKey', 'names', 'defaultLanguage', 'continent', 'sortOrder', 'flag'], 'Country');
    const stableKey = string(country.stableKey, 'Country stable key', 128);
    if (!STABLE_KEY.test(stableKey) || stableKeys.has(stableKey)) invalid('INVALID_STABLE_KEY', 'Country stable key is invalid or duplicated.');
    stableKeys.add(stableKey);
    const names = validateLocalizedNames(country.names, country.defaultLanguage);
    if (Object.keys(names.names).some(language => !countryLanguages.includes(language))) {
      invalid('UNDECLARED_COUNTRY_LANGUAGE', 'Country names must use declared country languages.');
    }
    return {
      stableKey,
      ...names,
      continent: country.continent == null ? null : string(country.continent, 'Continent', 80),
      sortOrder: integer(country.sortOrder, 'Country sort order'),
      flag: atField('flag', () => validateFlag(country.flag))
    };
  }));
  return {...localized, countryLanguages, countries};
}

export function validateCommitteeTemplate(value: unknown): CommitteeTemplateInput {
  const raw = object(value, 'Committee template');
  exactKeys(raw, ['names', 'defaultLanguage', 'countryTemplateKey', 'members'], 'Committee template');
  const localized = validateLocalizedNames(raw.names, raw.defaultLanguage);
  const countryTemplateKey = string(raw.countryTemplateKey, 'Country template key', 200);
  if (countryTemplateKey !== 'builtin:default' && !/^custom:[0-9a-f-]{36}$/.test(countryTemplateKey)) {
    invalid('INVALID_COUNTRY_TEMPLATE', 'Country template key is invalid.');
  }
  if (!Array.isArray(raw.members) || raw.members.length < 1 || raw.members.length > 512) {
    invalid('INVALID_TEMPLATE_MEMBER_COUNT', 'Committee template members are invalid.');
  }
  const stableKeys = new Set<string>();
  const members = raw.members.map((candidate, index) => atField(`members.${index}`, () => {
    const member = object(candidate, `Member ${index + 1}`);
    exactKeys(member, ['stableKey', 'names', 'defaultLanguage', 'rank', 'canVote', 'hasVeto', 'mustVote', 'sortOrder', 'flag'], 'Template member');
    const stableKey = string(member.stableKey, 'Member stable key', 128);
    if (!STABLE_KEY.test(stableKey) || stableKeys.has(stableKey)) invalid('INVALID_STABLE_KEY', 'Member stable key is invalid or duplicated.');
    stableKeys.add(stableKey);
    if (!RANKS.has(member.rank as SeatRank)
      || typeof member.canVote !== 'boolean' || typeof member.hasVeto !== 'boolean'
      || typeof member.mustVote !== 'boolean') invalid('INVALID_SEAT_PROPERTIES', 'Member voting properties are invalid.');
    if ((member.hasVeto || member.mustVote) && !member.canVote) invalid('VOTING_RIGHTS_REQUIRED', 'Seat capabilities require voting rights.');
    return {
      stableKey,
      ...validateLocalizedNames(member.names, member.defaultLanguage),
      rank: member.rank as SeatRank,
      canVote: member.canVote,
      hasVeto: member.hasVeto,
      mustVote: member.mustVote,
      sortOrder: integer(member.sortOrder, 'Member sort order'),
      flag: atField('flag', () => validateFlag(member.flag))
    };
  }));
  return {...localized, countryTemplateKey, members};
}

export function assertExactBody(value: Record<string, unknown>, keys: readonly string[], name = 'Request'): void {
  exactKeys(value, keys, name);
}
