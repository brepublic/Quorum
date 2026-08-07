import * as React from 'react';
import {useEffect, useMemo, useState} from 'react';
import firebase from 'firebase/compat/app';
import {
  Button,
  Confirm,
  Container,
  Dropdown,
  Form,
  Grid,
  Header,
  Icon,
  List,
  Menu,
  Message,
  Segment,
  Table
} from 'semantic-ui-react';
import {Helmet} from 'react-helmet';
import {Login} from '../components/auth';
import {
  getLanguage,
  LANGUAGE_OPTIONS,
  Language,
  LanguageMenuItem,
  SUPPORTED_LANGUAGES,
  t
} from '../i18n';
import {meetId} from '../utils';
import {
  cloneCountryTemplate,
  CONTINENTS,
  Continent,
  CountryData,
  countryDisplayName,
  countryNameLanguages,
  CountryTemplateData,
  countryTemplateDefaultLanguage,
  countryTemplateDisplayName,
  DEFAULT_COUNTRY_TEMPLATE,
  deleteUserCountryTemplate,
  putUserCountryTemplate,
  resizeFlagImage,
  userCountryTemplatesRef
} from '../models/country-template';

type LocalizedNameDraft = {id: string; language: Language; name: string};
type DraftCountry = CountryData & {id: string};

const BUILTIN_ID = 'builtin:default';
export default function Countries() {
  const displayLanguage = getLanguage();
  const [user, setUser] = useState<firebase.User | null>();
  const [templates, setTemplates] = useState<Record<string, CountryTemplateData>>({});
  const [selectedID, setSelectedID] = useState<string>();
  const [name, setName] = useState('');
  const [defaultLanguage, setDefaultLanguage] = useState<Language>(displayLanguage);
  const [nameIsFallback, setNameIsFallback] = useState(false);
  const [localizedNames, setLocalizedNames] = useState<LocalizedNameDraft[]>([]);
  const [languages, setLanguages] = useState<Language[]>([displayLanguage]);
  const [countries, setCountries] = useState<DraftCountry[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => firebase.auth().onAuthStateChanged(setUser), []);

  useEffect(() => {
    if (!user) {
      setTemplates({});
      return;
    }
    const ref = userCountryTemplatesRef(user.uid);
    const callback = (snapshot: firebase.database.DataSnapshot) => setTemplates(snapshot.val() || {});
    ref.on('value', callback);
    return () => ref.off('value', callback);
  }, [user]);

  const isBuiltin = selectedID === BUILTIN_ID;
  const unusedTemplateLanguages = SUPPORTED_LANGUAGES.filter(
    language => language !== displayLanguage
      && !localizedNames.some(localizedName => localizedName.language === language)
  );
  const unusedCountryLanguages = SUPPORTED_LANGUAGES.filter(language => !languages.includes(language));
  const continentOptions = useMemo(() => CONTINENTS.map(continent => ({
    key: continent,
    value: continent,
    text: t(continent)
  })), []);
  const flagTypeOptions = useMemo(() => [
    {key: 'emoji', value: 'emoji', text: 'Emoji'},
    {key: 'image', value: 'image', text: t('Image')}
  ], []);

  const loadTemplate = (id: string, template: CountryTemplateData) => {
    const templateLanguage = countryTemplateDefaultLanguage(template);
    const exactDisplayName = template.names?.[displayLanguage]?.trim()
      || (displayLanguage === templateLanguage ? template.name.trim() : '');
    const discoveredLanguages = countryNameLanguages(template, displayLanguage);
    setSelectedID(id);
    setDefaultLanguage(templateLanguage);
    setName(exactDisplayName || countryTemplateDisplayName(template, displayLanguage));
    setNameIsFallback(!exactDisplayName);
    setLocalizedNames(SUPPORTED_LANGUAGES
      .filter(language => language !== displayLanguage && !!(
        template.names?.[language]?.trim()
        || (language === templateLanguage && template.name.trim())
      ))
      .map(language => ({
        id: meetId(),
        language,
        name: template.names?.[language]?.trim()
          || (language === templateLanguage ? template.name.trim() : '')
      })));
    setLanguages([
      ...discoveredLanguages.filter(language => language === displayLanguage),
      ...discoveredLanguages.filter(language => language !== displayLanguage)
    ]);
    setCountries(Object.entries(template.countries || {}).map(([id, country]) => ({id, ...country})));
    setSaved(false);
    setError(undefined);
  };

  const startNew = () => {
    setSelectedID(undefined);
    setName('');
    setDefaultLanguage(displayLanguage);
    setNameIsFallback(false);
    setLocalizedNames([]);
    setLanguages([displayLanguage]);
    setCountries([]);
    setSaved(false);
    setError(undefined);
  };

  const addTemplateLanguage = () => {
    const language = unusedTemplateLanguages[0];
    if (language) {
      setLocalizedNames(current => [...current, {id: meetId(), language, name: ''}]);
      setSaved(false);
    }
  };

  const addCountryLanguage = () => {
    const language = unusedCountryLanguages[0];
    if (language) {
      setLanguages(current => [...current, language]);
      setSaved(false);
    }
  };

  const updateLocalizedName = (
    id: string,
    update: Partial<Pick<LocalizedNameDraft, 'language' | 'name'>>
  ) => {
    setLocalizedNames(current => current.map(item => item.id === id ? {...item, ...update} : item));
    setSaved(false);
  };

  const updateCountry = (id: string, update: Partial<CountryData>) => {
    setCountries(current => current.map(country => country.id === id ? {...country, ...update} : country));
    setSaved(false);
  };

  const updateCountryName = (id: string, language: Language, value: string) => {
    setCountries(current => current.map(country => country.id === id ? {
      ...country,
      names: {...country.names, [language]: value}
    } : country));
    setSaved(false);
  };

  const addCountry = () => {
    const language = languages[0] || displayLanguage;
    setCountries(current => [...current, {
      id: meetId(),
      name: '',
      defaultLanguage: language,
      names: {[language]: ''},
      flag: {type: 'emoji', value: '🏳️'}
    }]);
    setSaved(false);
  };

  const handleFlagImage = async (countryID: string, file?: File) => {
    if (!file) return;
    try {
      const value = await resizeFlagImage(file);
      updateCountry(countryID, {flag: {type: 'image', value}});
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? t(reason.message) : t('Could not process flag image'));
    }
  };

  const templateNamesForSave = (): {
    names: Partial<Record<Language, string>>;
    defaultLanguage: Language;
  } => {
    const trimmedName = name.trim();
    const names: Partial<Record<Language, string>> = {};
    if (!nameIsFallback) names[displayLanguage] = trimmedName;
    localizedNames.forEach(localizedName => {
      const value = localizedName.name.trim();
      if (value) names[localizedName.language] = value;
    });
    let savedDefaultLanguage = defaultLanguage;
    if (!names[savedDefaultLanguage]) {
      savedDefaultLanguage = SUPPORTED_LANGUAGES.find(language => !!names[language]) || displayLanguage;
      if (!names[savedDefaultLanguage]) names[savedDefaultLanguage] = trimmedName;
    }
    return {names, defaultLanguage: savedDefaultLanguage};
  };

  const countryHasName = (country: DraftCountry) => languages.some(
    language => !!country.names?.[language]?.trim()
  ) || !!country.name.trim();

  const save = async () => {
    if (!user || isBuiltin || !name.trim() || countries.length === 0 || countries.some(country => !countryHasName(country))) {
      return;
    }
    setSaving(true);
    const templateNames = templateNamesForSave();
    const savedCountries = countries.reduce<Record<string, CountryData>>((result, country) => {
      const names = Object.fromEntries(languages.flatMap(language => {
        const value = country.names?.[language]?.trim();
        return value ? [[language, value]] : [];
      })) as Partial<Record<Language, string>>;
      const savedCountryLanguage = languages.find(language => !!names[language])
        || country.defaultLanguage
        || languages[0];
      const savedCountry: CountryData = {
        name: names[savedCountryLanguage] || country.name.trim(),
        defaultLanguage: savedCountryLanguage,
        names
      };
      if (country.flag?.value) savedCountry.flag = country.flag;
      if (country.continent) savedCountry.continent = country.continent;
      result[country.id] = savedCountry;
      return result;
    }, {});
    try {
      const ref = await putUserCountryTemplate(user.uid, selectedID, {
        name: templateNames.names[templateNames.defaultLanguage] as string,
        defaultLanguage: templateNames.defaultLanguage,
        names: templateNames.names,
        countryLanguages: languages,
        countries: savedCountries
      });
      setSelectedID(ref.key ?? selectedID);
      setDefaultLanguage(templateNames.defaultLanguage);
      setName(name.trim());
      setNameIsFallback(!templateNames.names[displayLanguage]);
      setCountries(current => current.map(country => ({
        ...country,
        name: savedCountries[country.id].name,
        defaultLanguage: savedCountries[country.id].defaultLanguage,
        names: savedCountries[country.id].names
      })));
      setSaved(true);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Could not save country template'));
    } finally {
      setSaving(false);
    }
  };

  const cloneSelected = async () => {
    if (!user || !selectedID) return;
    const source = isBuiltin ? DEFAULT_COUNTRY_TEMPLATE : templates[selectedID];
    if (!source) return;
    setSaving(true);
    try {
      const clone = cloneCountryTemplate(source, displayLanguage);
      const ref = await putUserCountryTemplate(user.uid, undefined, clone);
      loadTemplate(ref.key!, clone);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Could not clone country template'));
    } finally {
      setSaving(false);
    }
  };

  const removeTemplate = async () => {
    if (!user || !selectedID || isBuiltin) return;
    try {
      await deleteUserCountryTemplate(user.uid, selectedID);
      setDeleteOpen(false);
      startNew();
    } catch (reason) {
      setDeleteOpen(false);
      setError(reason instanceof Error ? reason.message : t('Could not delete country template'));
    }
  };

  const invalidCountries = countries.some(country => !countryHasName(country));

  return (
    <Container style={{padding: '1em 0 2em'}}>
      <Helmet><title>{`${t('Country manager')} - Muncoordinated`}</title></Helmet>
      <Menu secondary>
        <Menu.Item as="a" href="/onboard"><Icon name="arrow left" />{t('Create committee')}</Menu.Item>
        <Menu.Item as="a" href="/templates"><Icon name="file alternate outline" />{t('Template editor')}</Menu.Item>
        <LanguageMenuItem position="right" />
      </Menu>
      <Header as="h1">{t('Country manager')}</Header>

      {user === undefined && <Segment loading style={{minHeight: 120}} />}
      {user === null && (
        <Grid stackable columns={2}>
          <Grid.Column><Message warning content={t('Log in to manage your country templates')} /></Grid.Column>
          <Grid.Column><Login allowNewCommittee={false} /></Grid.Column>
        </Grid>
      )}

      {user && (
        <Grid stackable columns={2}>
          <Grid.Column width={5}>
            <Segment>
              <Button primary fluid icon labelPosition="left" onClick={startNew}>
                <Icon name="plus" />{t('New country template')}
              </Button>
              <List divided relaxed selection>
                <List.Item active={selectedID === BUILTIN_ID} onClick={() => loadTemplate(BUILTIN_ID, DEFAULT_COUNTRY_TEMPLATE)}>
                  <Icon name="world" />
                  <List.Content>
                    <List.Header>{countryTemplateDisplayName(DEFAULT_COUNTRY_TEMPLATE)}</List.Header>
                    <List.Description>{t('Built-in')} · {t('{count} countries', {count: Object.keys(DEFAULT_COUNTRY_TEMPLATE.countries).length})}</List.Description>
                  </List.Content>
                </List.Item>
                {Object.entries(templates).map(([id, template]) => (
                  <List.Item key={id} active={id === selectedID} onClick={() => loadTemplate(id, template)}>
                    <Icon name="globe" />
                    <List.Content>
                      <List.Header>{countryTemplateDisplayName(template)}</List.Header>
                      <List.Description>{t('{count} countries', {count: Object.keys(template.countries || {}).length})}</List.Description>
                    </List.Content>
                  </List.Item>
                ))}
                {Object.keys(templates).length === 0 && (
                  <List.Item><List.Content>{t('No custom country templates yet')}</List.Content></List.Item>
                )}
              </List>
            </Segment>
          </Grid.Column>

          <Grid.Column width={11}>
            <Segment>
              <Header as="h2">{isBuiltin ? t('Default country template') : selectedID ? t('Edit country template') : t('New country template')}</Header>
              {isBuiltin && <Message info content={t('The built-in country template is read-only. Clone it to customize the countries.')} />}
              <Form success={saved} error={!!error} warning={countries.length === 0 || invalidCountries} onSubmit={save}>
                <Form.Input
                  required
                  disabled={isBuiltin}
                  label={t('Country template name')}
                  value={name}
                  placeholder={t('Enter a country template name')}
                  onChange={event => {
                    setName(event.currentTarget.value);
                    setNameIsFallback(false);
                    setSaved(false);
                  }}
                />
                <div className="template-localized-names">
                  {localizedNames.map(localizedName => (
                    <Form.Group key={localizedName.id} className="template-localized-name-row">
                      <Form.Dropdown
                        disabled={isBuiltin}
                        label={t('Language')}
                        selection
                        value={localizedName.language}
                        options={LANGUAGE_OPTIONS.filter(option =>
                          option.value !== displayLanguage
                          && (option.value === localizedName.language
                            || !localizedNames.some(item => item.language === option.value))
                        )}
                        onChange={(_event, data) => updateLocalizedName(localizedName.id, {language: data.value as Language})}
                      />
                      <Form.Input
                        disabled={isBuiltin}
                        label={t('Country template name')}
                        value={localizedName.name}
                        placeholder={t('Enter a country template name')}
                        onChange={event => updateLocalizedName(localizedName.id, {name: event.currentTarget.value})}
                      />
                      {!isBuiltin && <Form.Button
                        type="button" basic negative icon="trash" aria-label={t('Remove')}
                        onClick={() => setLocalizedNames(current => current.filter(item => item.id !== localizedName.id))}
                      />}
                    </Form.Group>
                  ))}
                  {!isBuiltin && unusedTemplateLanguages.length > 0 && (
                    <Button type="button" fluid className="add-template-language" onClick={addTemplateLanguage}>
                      <Icon name="plus" />{t('Other language')}
                    </Button>
                  )}
                </div>

                <div className="country-editor-heading">
                  <Header as="h3">{t('Countries')}</Header>
                  {!isBuiltin && unusedCountryLanguages.length > 0 && (
                    <Button type="button" basic onClick={addCountryLanguage}>
                      <Icon name="language" />{t('Add country name language')}
                    </Button>
                  )}
                </div>
                <div className="country-table-scroll">
                  <Table compact celled className="country-editor-table">
                    <Table.Header><Table.Row>
                      {languages.map(language => (
                        <Table.HeaderCell key={language}>{t('Country name')} · {LANGUAGE_OPTIONS.find(option => option.value === language)?.text}</Table.HeaderCell>
                      ))}
                      <Table.HeaderCell>{t('Flag')}</Table.HeaderCell>
                      <Table.HeaderCell>{t('Continent')}</Table.HeaderCell>
                      {!isBuiltin && <Table.HeaderCell />}
                    </Table.Row></Table.Header>
                    <Table.Body>
                      {countries.map(country => (
                        <Table.Row key={country.id}>
                          {languages.map((language, index) => (
                            <Table.Cell key={language}>
                              <Form.Input
                                required={languages.length === 1 && index === 0}
                                disabled={isBuiltin}
                                aria-label={`${t('Country name')} ${language}`}
                                value={country.names?.[language]
                                  ?? (language === country.defaultLanguage ? country.name : '')}
                                placeholder={index === 0 ? t('Required') : t('Optional')}
                                onChange={event => updateCountryName(country.id, language, event.currentTarget.value)}
                              />
                            </Table.Cell>
                          ))}
                          <Table.Cell>
                            <div className="country-flag-editor">
                              {country.flag?.type === 'image'
                                ? <img src={country.flag.value} alt={countryDisplayName(country)} />
                                : <span className="country-flag-emoji">{country.flag?.value || '🏳️'}</span>}
                              <Dropdown
                                compact selection disabled={isBuiltin}
                                value={country.flag?.type || 'emoji'} options={flagTypeOptions}
                                onChange={(_event, data) => updateCountry(country.id, {
                                  flag: data.value === 'image'
                                    ? {type: 'image', value: country.flag?.type === 'image' ? country.flag.value : ''}
                                    : {type: 'emoji', value: country.flag?.type === 'emoji' ? country.flag.value : '🏳️'}
                                })}
                              />
                              {country.flag?.type === 'image' ? (
                                !isBuiltin && <input
                                  type="file" accept="image/*" aria-label={t('Upload flag image')}
                                  onChange={event => handleFlagImage(country.id, event.currentTarget.files?.[0])}
                                />
                              ) : (
                                <Form.Input
                                  disabled={isBuiltin}
                                  aria-label={t('Flag emoji')}
                                  value={country.flag?.value || ''}
                                  placeholder="🏳️"
                                  onChange={event => updateCountry(country.id, {flag: {type: 'emoji', value: event.currentTarget.value}})}
                                />
                              )}
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <Dropdown
                              fluid selection clearable disabled={isBuiltin}
                              value={country.continent || ''} options={continentOptions}
                              placeholder={t('Select continent')}
                              onChange={(_event, data) => updateCountry(country.id, {continent: data.value as Continent || undefined})}
                            />
                          </Table.Cell>
                          {!isBuiltin && <Table.Cell collapsing>
                            <Button
                              type="button" basic negative icon="trash" aria-label={t('Remove')}
                              onClick={() => {
                                setCountries(current => current.filter(item => item.id !== country.id));
                                setSaved(false);
                              }}
                            />
                          </Table.Cell>}
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
                {!isBuiltin && <Button type="button" fluid basic className="add-country-button" onClick={addCountry}>
                  <Icon name="plus" />{t('Add country')}
                </Button>}
                {countries.length === 0 && <Message warning content={t('Add at least one country')} />}
                {invalidCountries && <Message warning content={t('Every country needs a name')} />}
                <Message success content={t('Country template saved')} />
                {error && <Message error content={error} onDismiss={() => setError(undefined)} />}
                {!isBuiltin && <Button type="submit" primary loading={saving} disabled={!name.trim() || countries.length === 0 || invalidCountries}>
                  <Icon name="save" />{t('Save country template')}
                </Button>}
                {selectedID && <Button type="button" basic primary onClick={cloneSelected} loading={saving}>
                  <Icon name="copy outline" />{t('Clone country template')}
                </Button>}
                {selectedID && !isBuiltin && <Button type="button" negative basic floated="right" onClick={() => setDeleteOpen(true)}>
                  <Icon name="trash" />{t('Delete country template')}
                </Button>}
              </Form>
            </Segment>
          </Grid.Column>
        </Grid>
      )}

      <Confirm
        open={deleteOpen}
        header={t('Delete country template?')}
        content={t('Are you sure that you want to delete this country template?')}
        cancelButton={t('Cancel')}
        confirmButton={t('Delete')}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={removeTemplate}
      />
    </Container>
  );
}
