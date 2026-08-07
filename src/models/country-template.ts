import firebase from 'firebase/compat/app';
import {COUNTRY_OPTIONS} from '../constants';
import {getLanguage, Language, SUPPORTED_LANGUAGES} from '../i18n';

export type CountryTemplateID = string;
export type Continent =
  | 'Africa'
  | 'Antarctica'
  | 'Asia'
  | 'Europe'
  | 'North America'
  | 'Oceania'
  | 'South America';

export const CONTINENTS: readonly Continent[] = [
  'Africa',
  'Antarctica',
  'Asia',
  'Europe',
  'North America',
  'Oceania',
  'South America'
];

export type CountryFlag =
  | {type: 'emoji'; value: string}
  | {type: 'image'; value: string};

export interface CountryData {
  /** Legacy-compatible name in the country's default language. */
  name: string;
  defaultLanguage?: Language;
  names?: Partial<Record<Language, string>>;
  flag?: CountryFlag;
  continent?: Continent;
}

export interface CountryTemplateData {
  /** Legacy-compatible name in the template's default language. */
  name: string;
  defaultLanguage?: Language;
  names?: Partial<Record<Language, string>>;
  /** Languages for which every country gets a name field in the editor. */
  countryLanguages?: Language[];
  countries: Record<string, CountryData>;
}

const languageOrFallback = (language: Language | undefined, fallback: Language): Language =>
  SUPPORTED_LANGUAGES.includes(language as Language) ? language as Language : fallback;

const localizedName = (
  item: Pick<CountryData, 'name' | 'defaultLanguage' | 'names'>,
  language: Language,
  fallback: Language = language
): string => item.names?.[language]?.trim()
  || item.names?.[languageOrFallback(item.defaultLanguage, fallback)]?.trim()
  || item.name?.trim()
  || Object.values(item.names || {}).find(candidate => candidate?.trim())?.trim()
  || '';

export const countryTemplateDefaultLanguage = (
  template: CountryTemplateData,
  fallback: Language = getLanguage()
): Language => languageOrFallback(template.defaultLanguage, fallback);

export const countryTemplateDisplayName = (
  template: CountryTemplateData,
  language: Language = getLanguage()
): string => localizedName(template, language, countryTemplateDefaultLanguage(template, language));

export const countryDisplayName = (
  country: CountryData,
  language: Language = getLanguage()
): string => localizedName(country, language);

export const countryNameLanguages = (
  template: CountryTemplateData,
  fallback: Language = getLanguage()
): Language[] => {
  const declared = (template.countryLanguages || [])
    .filter((language): language is Language => SUPPORTED_LANGUAGES.includes(language as Language));
  const discovered = Object.values(template.countries || {}).flatMap(country =>
    Object.keys(country.names || {}).filter(
      (language): language is Language => SUPPORTED_LANGUAGES.includes(language as Language)
    )
  );
  const result = [...new Set([...declared, ...discovered])];
  return result.length > 0 ? result : [countryTemplateDefaultLanguage(template, fallback)];
};

export const isoCodeToEmoji = (code: string): string => {
  if (!/^[a-z]{2}$/i.test(code)) {
    return '🏳️';
  }
  return [...code.toUpperCase()]
    .map(character => String.fromCodePoint(127397 + character.charCodeAt(0)))
    .join('');
};

const CONTINENT_CODES: Readonly<Record<Continent, ReadonlySet<string>>> = {
  Africa: new Set(('dz ao bj bw bf bi cv cm cf td km cg cd ci dj eg gq er sz et ga gm gh gn gw ke ls lr ly mg mw ml mr mu yt ma mz na ne ng re rw sh st sn sc sl so za ss sd tg tn ug eh zm zw tz').split(' ')),
  Antarctica: new Set(('aq bv tf hm gs').split(' ')),
  Asia: new Set(('af am az bh bd bt bn kh cn cx ge hk in id ir iq il jp jo kz kw kg la lb mo my mv mn mm np kp om pk ps ph qa sa sg kr lk sy tw tj th tl tr tm ae uz vn ye io').split(' ')),
  Europe: new Set(('ax al ad at by be ba bg hr cy cz dk ee eu fo fi fr de gi gr gg va hu is ie im it je lv li lt lu mt md mc me nl mk no pl pt ro ru sm rs sk si es sj se ch ua gb').split(' ')),
  'North America': new Set(('ai ag aw bs bb bz bm bq vg ca ky cr cu cw dm do sv gl gd gp gt ht hn jm mq mx ms ni pa pr bl kn lc mf pm vc sx tc tt us vi').split(' ')),
  Oceania: new Set(('as au cc ck fj pf gu ki mh fm nr nc nz nu nf mp pw pg pn ws sb tk to tv um vu wf').split(' ')),
  'South America': new Set(('ar bo br cl co ec fk gf gy py pe sr uy ve').split(' '))
};

export const countryContinent = (code: string): Continent | undefined =>
  CONTINENTS.find(continent => CONTINENT_CODES[continent].has(code.toLowerCase()));

const regionDisplayName = (code: string, language: Language, fallback: string): string => {
  if (language === 'en' || typeof Intl.DisplayNames !== 'function') {
    return fallback;
  }
  try {
    return new Intl.DisplayNames([language], {type: 'region'}).of(code.toUpperCase()) || fallback;
  } catch {
    return fallback;
  }
};

export const DEFAULT_COUNTRY_TEMPLATE: CountryTemplateData = {
  name: 'Default countries',
  defaultLanguage: 'en',
  names: {
    en: 'Default countries',
    'zh-CN': '默认国家'
  },
  countryLanguages: [...SUPPORTED_LANGUAGES],
  countries: Object.fromEntries(COUNTRY_OPTIONS.map(option => [option.value, {
    name: option.text,
    defaultLanguage: 'en',
    names: Object.fromEntries(SUPPORTED_LANGUAGES.map(language => [
      language,
      regionDisplayName(option.value, language, option.text)
    ])) as Partial<Record<Language, string>>,
    flag: {type: 'emoji', value: isoCodeToEmoji(option.value)},
    continent: countryContinent(option.value)
  }]))
};

export const userCountryTemplatesRef = (uid: string): firebase.database.Reference =>
  firebase.database().ref('countryTemplates').child(uid);

export const putUserCountryTemplate = (
  uid: string,
  templateID: CountryTemplateID | undefined,
  template: CountryTemplateData
): Promise<firebase.database.Reference> => {
  const ref = templateID
    ? userCountryTemplatesRef(uid).child(templateID)
    : userCountryTemplatesRef(uid).push();
  return ref.set(template).then(() => ref);
};

export const deleteUserCountryTemplate = (
  uid: string,
  templateID: CountryTemplateID
): Promise<void> => userCountryTemplatesRef(uid).child(templateID).remove();

export const cloneCountryTemplate = (
  template: CountryTemplateData,
  language: Language = getLanguage()
): CountryTemplateData => {
  const copyName = `${countryTemplateDisplayName(template, language)} (${language === 'zh-CN' ? '副本' : 'copy'})`;
  return {
    ...structuredClone(template),
    name: copyName,
    defaultLanguage: language,
    names: { ...(template.names || {}), [language]: copyName }
  };
};

export const fitImageSize = (
  width: number,
  height: number,
  maxWidth = 256,
  maxHeight = 160
): {width: number; height: number} => {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
};

export const resizeFlagImage = (file: File): Promise<string> => new Promise((resolve, reject) => {
  if (!file.type.startsWith('image/')) {
    reject(new Error('Please choose an image file'));
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    reject(new Error('Flag images must be smaller than 5 MB'));
    return;
  }

  const image = new Image();
  const objectURL = URL.createObjectURL(file);
  image.onload = () => {
    URL.revokeObjectURL(objectURL);
    const size = fitImageSize(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) {
      reject(new Error('Could not process flag image'));
      return;
    }
    context.drawImage(image, 0, 0, size.width, size.height);
    resolve(canvas.toDataURL('image/webp', 0.82));
  };
  image.onerror = () => {
    URL.revokeObjectURL(objectURL);
    reject(new Error('Could not process flag image'));
  };
  image.src = objectURL;
});
