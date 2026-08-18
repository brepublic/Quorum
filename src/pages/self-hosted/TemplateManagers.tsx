import * as React from 'react';
import type {
  CommitteeTemplate,
  CommitteeTemplateInput,
  CommitteeTemplateMember,
  CountryTemplate,
  CountryTemplateCountry,
  FlagSnapshot,
  LocalizedNames,
  SeatRank
} from '@quorum/contracts';
import {
  Button, Checkbox, Confirm, Container, Dropdown, Form, Grid, Header, Icon, List, Message, Segment, Table
} from 'semantic-ui-react';
import {CountryFlagDisplay} from '../../components/CountryFlagDisplay';
import {getLanguage, LANGUAGE_OPTIONS, type Language, SUPPORTED_LANGUAGES, t} from '../../i18n';
import {SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';

type LocalizedNameDraft = {id: string; language: Language; name: string};
type DraftCountry = Omit<CountryTemplateCountry, 'revision'> & {flagMode: FlagSnapshot['type']};
type DraftMember = Omit<CommitteeTemplateMember, 'revision'>;

const CONTINENTS = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'] as const;
const RANKS: readonly SeatRank[] = ['STANDARD', 'VETO', 'NGO', 'OBSERVER'];
const draftId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
export const localizedDisplayName = (names: LocalizedNames, defaultLanguage: string) =>
  names[getLanguage()]?.trim() || names[defaultLanguage]?.trim() || Object.values(names).find(Boolean) || '';

function errorText(error: unknown): string {
  const details = error instanceof SelfHostedApiError && error.details && typeof error.details === 'object'
    ? error.details as {templates?: unknown} : undefined;
  if (error instanceof SelfHostedApiError && error.code === 'RESOURCE_CONFLICT'
    && Array.isArray(details?.templates)) {
    const templates = (details.templates as Array<{name?: string}>).map(item => item.name).filter(Boolean).join('、');
    if (templates) return t('This country template cannot be deleted because it is used by: {templates}', {templates});
  }
  return error instanceof Error ? error.message : String(error);
}

function FlagDisplay({flag}: {flag: FlagSnapshot}) {
  return <CountryFlagDisplay flag={flag} />;
}

function resizeFlagImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error(t('Please choose an image file'))); return; }
    if (file.size > 5 * 1024 * 1024) { reject(new Error(t('Flag images must be smaller than 5 MB'))); return; }
    const image = new Image(); const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, 256 / image.naturalWidth, 160 / image.naturalHeight);
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) { reject(new Error(t('Could not process flag image'))); return; }
      context.drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL('image/webp', 0.82));
    };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error(t('Could not process flag image'))); };
    image.src = objectUrl;
  });
}

function localizedDrafts(names: LocalizedNames, displayLanguage: Language): LocalizedNameDraft[] {
  return SUPPORTED_LANGUAGES.filter(language => language !== displayLanguage && !!names[language]?.trim())
    .map(language => ({id: draftId('language'), language, name: names[language] as string}));
}

export function CountryTemplateManager({api}: {api: SelfHostedApi}) {
  const displayLanguage = getLanguage();
  const [templates, setTemplates] = React.useState<CountryTemplate[]>([]); const [selectedId, setSelectedId] = React.useState<string>();
  const [name, setName] = React.useState(''); const [defaultLanguage, setDefaultLanguage] = React.useState<Language>(displayLanguage);
  const [localizedNames, setLocalizedNames] = React.useState<LocalizedNameDraft[]>([]); const [languages, setLanguages] = React.useState<Language[]>([displayLanguage]);
  const [countries, setCountries] = React.useState<DraftCountry[]>([]); const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [saved, setSaved] = React.useState(false); const [saving, setSaving] = React.useState(false); const [error, setError] = React.useState<string>();
  const selected = templates.find(template => template.id === selectedId); const isBuiltin = selected?.builtin ?? false;

  const refresh = React.useCallback(async () => { const next = await api.listCountryTemplates(); setTemplates(next); return next; }, [api]);
  React.useEffect(() => { void refresh().catch(caught => setError(errorText(caught))); }, [refresh]);

  const load = React.useCallback((template: CountryTemplate) => {
    setSelectedId(template.id); setName(localizedDisplayName(template.names, template.defaultLanguage));
    setDefaultLanguage((SUPPORTED_LANGUAGES.includes(template.defaultLanguage as Language) ? template.defaultLanguage : displayLanguage) as Language);
    setLocalizedNames(localizedDrafts(template.names, displayLanguage));
    const declared = template.countryLanguages.filter(language => SUPPORTED_LANGUAGES.includes(language as Language)) as Language[];
    setLanguages(declared.length ? declared : [displayLanguage]);
    setCountries(template.countries.map(country => ({id: country.id, stableKey: country.stableKey, names: {...country.names},
      defaultLanguage: country.defaultLanguage, continent: country.continent, sortOrder: country.sortOrder, flag: country.flag,
      flagMode: country.flag.type})));
    setSaved(false); setError(undefined);
  }, [displayLanguage]);

  const startNew = () => { setSelectedId(undefined); setName(''); setDefaultLanguage(displayLanguage); setLocalizedNames([]);
    setLanguages([displayLanguage]); setCountries([]); setSaved(false); setError(undefined); };

  const create = async () => {
    if (!name.trim()) return; setSaving(true); setError(undefined);
    try {
      const created = await api.createCountryTemplate({names: {[displayLanguage]: name.trim()}, defaultLanguage: displayLanguage,
        countryLanguages: [displayLanguage], countries: []});
      const next = await refresh(); load(next.find(item => item.id === created.id) ?? created);
    } catch (caught) { setError(errorText(caught)); } finally { setSaving(false); }
  };

  const templateNames = (): {names: LocalizedNames; defaultLanguage: Language} => {
    const names: LocalizedNames = {[displayLanguage]: name.trim()};
    localizedNames.forEach(item => { if (item.name.trim()) names[item.language] = item.name.trim(); });
    const nextDefault = names[defaultLanguage] ? defaultLanguage : displayLanguage;
    return {names, defaultLanguage: nextDefault};
  };

  const save = async () => {
    if (!selected || isBuiltin || !name.trim() || countries.some(country => !languages.some(language => country.names[language]?.trim())
      || (country.flagMode === 'IMAGE' && country.flag.type !== 'IMAGE'))) return;
    setSaving(true); setError(undefined);
    try {
      const localized = templateNames();
      const updated = await api.updateCountryTemplate(selected.id, selected.revision, {names: localized.names,
        defaultLanguage: localized.defaultLanguage, countryLanguages: languages, countries: countries.map((country, sortOrder) => ({
          stableKey: country.stableKey, names: Object.fromEntries(Object.entries(country.names).filter(([language, value]) =>
            languages.includes(language as Language) && value.trim())), defaultLanguage: country.names[country.defaultLanguage]?.trim()
            ? country.defaultLanguage : languages.find(language => country.names[language]?.trim()) as string,
          continent: country.continent, sortOrder, flag: country.flag
        }))});
      const next = await refresh(); load(next.find(item => item.id === updated.id) ?? updated); setSaved(true);
    } catch (caught) { setError(errorText(caught)); } finally { setSaving(false); }
  };

  const clone = async () => {
    if (!selected) return; setSaving(true); setError(undefined);
    const copyName = `${localizedDisplayName(selected.names, selected.defaultLanguage)} (${displayLanguage === 'zh-CN' ? '副本' : 'copy'})`;
    try { const copy = await api.cloneCountryTemplate(selected.id, {...selected.names, [displayLanguage]: copyName}, displayLanguage);
      const next = await refresh(); load(next.find(item => item.id === copy.id) ?? copy); }
    catch (caught) { setError(errorText(caught)); } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!selected || isBuiltin) return;
    try { await api.deleteCountryTemplate(selected.id); await refresh(); setDeleteOpen(false); startNew(); }
    catch (caught) { setDeleteOpen(false); setError(errorText(caught)); }
  };

  const updateCountry = (id: string, patch: Partial<DraftCountry>) => { setCountries(current => current.map(country =>
    country.id === id ? {...country, ...patch} : country)); setSaved(false); };
  const unusedTemplateLanguages = SUPPORTED_LANGUAGES.filter(language => language !== displayLanguage
    && !localizedNames.some(item => item.language === language));
  const unusedCountryLanguages = SUPPORTED_LANGUAGES.filter(language => !languages.includes(language));

  return <Container fluid className="country-manager-page">
    <Header as="h1">{t('Country manager')}</Header>
    <Grid stackable className="country-manager-layout">
      <Grid.Column className="country-manager-sidebar"><Segment>
        <Button primary fluid icon labelPosition="left" onClick={startNew}><Icon name="plus" />{t('New country template')}</Button>
        <List divided relaxed selection>{templates.map(template => <List.Item key={template.id} active={template.id === selectedId} onClick={() => load(template)}>
          <Icon name={template.builtin ? 'world' : 'globe'} /><List.Content><List.Header>{localizedDisplayName(template.names, template.defaultLanguage)}</List.Header>
            <List.Description>{template.builtin ? `${t('Built-in')} · ` : ''}{t('{count} countries', {count: template.countries.length})}</List.Description>
          </List.Content></List.Item>)}</List>
      </Segment></Grid.Column>
      <Grid.Column className="country-manager-editor"><Segment loading={saving}>
        {!selected ? <Form onSubmit={create} error={!!error}><Header as="h2">{t('New country template')}</Header>
          <Form.Input required label={t('Country template name')} value={name} placeholder={t('Enter a country template name')}
            onChange={event => setName(event.currentTarget.value)} />
          {error && <Message error content={error} />}<Button primary disabled={!name.trim()}>{t('Create country template')}</Button>
        </Form> : <>
          <div className="country-template-editor-header"><Header as="h2">{isBuiltin ? t('Default country template') : t('Edit country template')}</Header>
            <Button type="button" basic primary onClick={() => void clone()}><Icon name="copy outline" />{t('Clone country template')}</Button></div>
          {isBuiltin && <Message info content={t('The built-in country template is read-only. Clone it to customize the countries.')} />}
          <Form success={saved} error={!!error} onSubmit={save}>
            <Form.Input required disabled={isBuiltin} label={t('Country template name')} value={name}
              onChange={event => {setName(event.currentTarget.value); setSaved(false);}} />
            <div className="template-localized-names">{localizedNames.map(item => <Form.Group key={item.id} className="template-localized-name-row">
              <Form.Dropdown disabled={isBuiltin} label={t('Language')} selection value={item.language}
                options={LANGUAGE_OPTIONS.filter(option => option.value !== displayLanguage && (option.value === item.language
                  || !localizedNames.some(candidate => candidate.language === option.value)))}
                onChange={(_event, data) => {setLocalizedNames(current => current.map(candidate => candidate.id === item.id
                  ? {...candidate, language: data.value as Language} : candidate)); setSaved(false);}} />
              <Form.Input disabled={isBuiltin} label={t('Country template name')} value={item.name}
                onChange={event => {setLocalizedNames(current => current.map(candidate => candidate.id === item.id
                  ? {...candidate, name: event.currentTarget.value} : candidate)); setSaved(false);}} />
              {!isBuiltin && <Form.Button type="button" basic negative icon="trash" aria-label={t('Remove')}
                onClick={() => setLocalizedNames(current => current.filter(candidate => candidate.id !== item.id))} />}
            </Form.Group>)}
            {!isBuiltin && unusedTemplateLanguages.length > 0 && <Button type="button" fluid className="add-template-language"
              onClick={() => setLocalizedNames(current => [...current, {id: draftId('language'), language: unusedTemplateLanguages[0]!, name: ''}])}>
              <Icon name="plus" />{t('Other language')}</Button>}</div>
            <div className="country-editor-heading"><Header as="h3">{t('Countries')}</Header>
              {!isBuiltin && unusedCountryLanguages.length > 0 && <Button type="button" basic onClick={() => {
                setLanguages(current => [...current, unusedCountryLanguages[0]!]); setSaved(false);}}>
                <Icon name="language" />{t('Add country name language')}</Button>}</div>
            <div className="country-table-scroll"><Table compact celled className="country-editor-table"><Table.Header><Table.Row>
              {languages.map(language => <Table.HeaderCell key={language}>{t('Country name')} · {LANGUAGE_OPTIONS.find(item => item.value === language)?.text}</Table.HeaderCell>)}
              <Table.HeaderCell>{t('Flag')}</Table.HeaderCell><Table.HeaderCell>{t('Continent')}</Table.HeaderCell>{!isBuiltin && <Table.HeaderCell />}
            </Table.Row></Table.Header><Table.Body>{countries.map(country => <Table.Row key={country.id}>
              {languages.map(language => <Table.Cell key={language}><Form.Input disabled={isBuiltin} value={country.names[language] ?? ''}
                onChange={event => updateCountry(country.id, {names: {...country.names, [language]: event.currentTarget.value}, defaultLanguage: country.defaultLanguage || language})} /></Table.Cell>)}
              <Table.Cell><div className="country-flag-editor"><FlagDisplay flag={country.flag} />
                <Dropdown disabled={isBuiltin} selection value={country.flagMode} options={[
                  {key: 'standard', value: 'STANDARD', text: t('Standard flag')}, {key: 'emoji', value: 'EMOJI', text: 'Emoji'},
                  {key: 'image', value: 'IMAGE', text: t('Image')}]}
                  onChange={(_event, data) => updateCountry(country.id, {flagMode: data.value as FlagSnapshot['type'],
                    ...(data.value === 'STANDARD' ? {flag: {type: 'STANDARD', value: 'un'} as FlagSnapshot}
                      : data.value === 'EMOJI' ? {flag: {type: 'EMOJI', value: '🏳️'} as FlagSnapshot} : {})})} />
                {country.flagMode !== 'IMAGE' && <Form.Input disabled={isBuiltin} maxLength={country.flagMode === 'STANDARD' ? 2 : undefined}
                  value={country.flag.value} onChange={event => updateCountry(country.id, {flag: {...country.flag, value: event.currentTarget.value} as FlagSnapshot})} />}
                {!isBuiltin && country.flagMode === 'IMAGE' && <input type="file" accept="image/*" onChange={event => {const file = event.currentTarget.files?.[0];
                  if (file) void resizeFlagImage(file).then(value => updateCountry(country.id, {flag: {type: 'IMAGE', value}, flagMode: 'IMAGE'}))
                    .catch(caught => setError(errorText(caught)));}} />}
              </div></Table.Cell>
              <Table.Cell><Dropdown disabled={isBuiltin} clearable selection value={country.continent ?? ''}
                options={CONTINENTS.map(continent => ({key: continent, value: continent, text: t(continent)}))}
                onChange={(_event, data) => updateCountry(country.id, {continent: String(data.value || '') || null})} /></Table.Cell>
              {!isBuiltin && <Table.Cell><Button type="button" basic negative icon="trash" aria-label={t('Remove')}
                onClick={() => {setCountries(current => current.filter(candidate => candidate.id !== country.id)); setSaved(false);}} /></Table.Cell>}
            </Table.Row>)}</Table.Body></Table></div>
            {!isBuiltin && <Button type="button" basic primary className="add-country-button" onClick={() => {const language = languages[0] ?? displayLanguage;
              setCountries(current => [...current, {id: draftId('country'), stableKey: draftId('country'), names: {[language]: ''},
                defaultLanguage: language, continent: null, sortOrder: current.length, flag: {type: 'EMOJI', value: '🏳️'}, flagMode: 'EMOJI'}]); setSaved(false);}}>
              <Icon name="plus" />{t('Add country')}</Button>}
            <Message success content={t('Country template saved')} />{error && <Message error content={error} onDismiss={() => setError(undefined)} />}
            {!isBuiltin && <><Button type="submit" primary disabled={!name.trim()}><Icon name="save" />{t('Save country template')}</Button>
              <Button type="button" negative basic floated="right" onClick={() => setDeleteOpen(true)}><Icon name="trash" />{t('Delete country template')}</Button></>}
          </Form>
        </>}
      </Segment></Grid.Column>
    </Grid>
    <Confirm open={deleteOpen} header={t('Delete country template?')} content={t('Are you sure that you want to delete this country template?')}
      cancelButton={t('Cancel')} confirmButton={t('Delete')} onCancel={() => setDeleteOpen(false)} onConfirm={() => void remove()} />
  </Container>;
}

export function CommitteeTemplateManager({api}: {api: SelfHostedApi}) {
  const displayLanguage = getLanguage(); const [templates, setTemplates] = React.useState<CommitteeTemplate[]>([]);
  const [countryTemplates, setCountryTemplates] = React.useState<CountryTemplate[]>([]); const [selectedId, setSelectedId] = React.useState<string>();
  const [name, setName] = React.useState(''); const [defaultLanguage, setDefaultLanguage] = React.useState<Language>(displayLanguage);
  const [localizedNames, setLocalizedNames] = React.useState<LocalizedNameDraft[]>([]); const [countryKey, setCountryKey] = React.useState('builtin:default');
  const [members, setMembers] = React.useState<DraftMember[]>([]); const [memberName, setMemberName] = React.useState('');
  const [rank, setRank] = React.useState<SeatRank>('STANDARD'); const [canVote, setCanVote] = React.useState(true);
  const [mustVote, setMustVote] = React.useState(false); const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [saved, setSaved] = React.useState(false); const [saving, setSaving] = React.useState(false); const [error, setError] = React.useState<string>();
  const customTemplates = templates.filter(template => !template.builtin);
  const selectedCountry = countryTemplates.find(template => template.key === countryKey);

  const refresh = React.useCallback(async () => { const [nextTemplates, nextCountries] = await Promise.all([
    api.listCommitteeTemplates(), api.listCountryTemplates()]); setTemplates(nextTemplates); setCountryTemplates(nextCountries);
    return {nextTemplates, nextCountries}; }, [api]);
  React.useEffect(() => { void refresh().catch(caught => setError(errorText(caught))); }, [refresh]);
  const startNew = () => {setSelectedId(undefined); setName(''); setDefaultLanguage(displayLanguage); setLocalizedNames([]);
    setCountryKey('builtin:default'); setMembers([]); setSaved(false); setError(undefined);};
  const load = (template: CommitteeTemplate) => {setSelectedId(template.id); setName(localizedDisplayName(template.names, template.defaultLanguage));
    setDefaultLanguage((SUPPORTED_LANGUAGES.includes(template.defaultLanguage as Language) ? template.defaultLanguage : displayLanguage) as Language);
    setLocalizedNames(localizedDrafts(template.names, displayLanguage)); setCountryKey(template.countryTemplateKey);
    setMembers(template.members.map(member => ({id: member.id, stableKey: member.stableKey, names: {...member.names},
      defaultLanguage: member.defaultLanguage, rank: member.rank, canVote: member.canVote, hasVeto: member.hasVeto,
      mustVote: member.mustVote, sortOrder: member.sortOrder, flag: member.flag}))); setSaved(false); setError(undefined);};
  const save = async () => {
    if (!name.trim() || members.length === 0 || !selectedCountry) return; setSaving(true); setError(undefined);
    const names: LocalizedNames = {[displayLanguage]: name.trim()}; localizedNames.forEach(item => {if (item.name.trim()) names[item.language] = item.name.trim();});
    const input: CommitteeTemplateInput = {names, defaultLanguage: names[defaultLanguage] ? defaultLanguage : displayLanguage, countryTemplateKey: countryKey,
      members: members.map((member, sortOrder) => ({stableKey: member.stableKey, names: member.names, defaultLanguage: member.defaultLanguage,
        rank: member.rank, canVote: member.canVote, hasVeto: member.hasVeto, mustVote: member.mustVote, sortOrder, flag: member.flag}))};
    try { const result = selectedId ? await api.updateCommitteeTemplate(selectedId, templates.find(item => item.id === selectedId)!.revision, input)
      : await api.createCommitteeTemplate(input); const {nextTemplates} = await refresh(); load(nextTemplates.find(item => item.id === result.id) ?? result); setSaved(true); }
    catch (caught) { setError(errorText(caught)); } finally { setSaving(false); }
  };
  const remove = async () => {if (!selectedId) return; try {await api.deleteCommitteeTemplate(selectedId); await refresh(); setDeleteOpen(false); startNew();}
    catch (caught) {setDeleteOpen(false); setError(errorText(caught));}};
  const countryOptions = selectedCountry?.countries.map(country => ({key: country.id, value: country.id,
    text: localizedDisplayName(country.names, country.defaultLanguage), country})) ?? [];
  const selectedMemberCountry = countryOptions.find(option => option.value === memberName)?.country;
  const duplicateMember = members.some(member => selectedMemberCountry
    ? member.stableKey === selectedMemberCountry.stableKey
    : localizedDisplayName(member.names, member.defaultLanguage).trim().toLocaleLowerCase() === memberName.trim().toLocaleLowerCase());
  const unusedLanguages = SUPPORTED_LANGUAGES.filter(language => language !== displayLanguage && !localizedNames.some(item => item.language === language));

  return <Container style={{padding: '1em 0 2em'}}><Header as="h1">{t('Template editor')}</Header>
    <Grid stackable columns={2}><Grid.Column width={5}><Segment>
      <Button primary fluid icon labelPosition="left" onClick={startNew}><Icon name="plus" />{t('New template')}</Button>
      <List divided relaxed selection>{customTemplates.map(template => <List.Item key={template.id} active={template.id === selectedId} onClick={() => load(template)}>
        <Icon name="file alternate outline" /><List.Content><List.Header>{localizedDisplayName(template.names, template.defaultLanguage)}</List.Header>
          <List.Description>{t('{count} members', {count: template.members.length})}</List.Description></List.Content></List.Item>)}
        {customTemplates.length === 0 && <List.Item><List.Content>{t('No custom templates yet')}</List.Content></List.Item>}
      </List></Segment></Grid.Column>
      <Grid.Column width={11}><Segment loading={saving}><Header as="h2">{selectedId ? t('Edit template') : t('New template')}</Header>
        <Form success={saved} error={!!error} warning={members.length === 0} onSubmit={save}>
          <Form.Input required label={t('Template name')} value={name} onChange={event => {setName(event.currentTarget.value); setSaved(false);}}
            placeholder={t('Enter a template name')} />
          <div className="template-localized-names">{localizedNames.map(item => <Form.Group key={item.id} className="template-localized-name-row">
            <Form.Dropdown label={t('Language')} selection value={item.language} options={LANGUAGE_OPTIONS.filter(option => option.value !== displayLanguage
              && (option.value === item.language || !localizedNames.some(candidate => candidate.language === option.value)))}
              onChange={(_event, data) => setLocalizedNames(current => current.map(candidate => candidate.id === item.id
                ? {...candidate, language: data.value as Language} : candidate))} />
            <Form.Input label={t('Template name')} value={item.name} onChange={event => setLocalizedNames(current => current.map(candidate =>
              candidate.id === item.id ? {...candidate, name: event.currentTarget.value} : candidate))} />
            <Form.Button type="button" basic negative icon="trash" aria-label={t('Remove')}
              onClick={() => setLocalizedNames(current => current.filter(candidate => candidate.id !== item.id))} />
          </Form.Group>)}{unusedLanguages.length > 0 && <Button type="button" fluid className="add-template-language"
            onClick={() => setLocalizedNames(current => [...current, {id: draftId('language'), language: unusedLanguages[0]!, name: ''}])}>
            <Icon name="plus" />{t('Other language')}</Button>}</div>
          <Form.Dropdown className="template-picker-field" required search fluid selection label={t('Country template')} value={countryKey}
            options={countryTemplates.map(template => ({key: template.key, value: template.key, text: localizedDisplayName(template.names, template.defaultLanguage),
              description: template.builtin ? t('Built-in') : t('My template')}))}
            onChange={(_event, data) => {setCountryKey(String(data.value)); setMemberName(''); setSaved(false);}} />
          <Header as="h3">{t('Committee members')}</Header><Table compact celled stackable><Table.Header><Table.Row>
            <Table.HeaderCell>{t('Country or delegation')}</Table.HeaderCell><Table.HeaderCell>{t('Rank')}</Table.HeaderCell>
            <Table.HeaderCell>{t('Voting')}</Table.HeaderCell><Table.HeaderCell>{t('Must Vote')}</Table.HeaderCell><Table.HeaderCell />
          </Table.Row></Table.Header><Table.Body>{members.map(member => <Table.Row key={member.id}>
            <Table.Cell><FlagDisplay flag={member.flag} />{localizedDisplayName(member.names, member.defaultLanguage)}</Table.Cell>
            <Table.Cell><Dropdown fluid selection value={member.rank} options={RANKS.map(value => ({key: value, value, text: t(value)}))}
              onChange={(_event, data) => setMembers(current => current.map(item => item.id === member.id
                ? {...item, rank: data.value as SeatRank, hasVeto: data.value === 'VETO'} : item))} /></Table.Cell>
            <Table.Cell collapsing><Checkbox toggle checked={member.canVote} onChange={(_event, data) => setMembers(current => current.map(item =>
              item.id === member.id ? {...item, canVote: data.checked ?? false, hasVeto: (data.checked ?? false) && item.rank === 'VETO'} : item))} /></Table.Cell>
            <Table.Cell collapsing><Checkbox toggle checked={member.mustVote} onChange={(_event, data) => setMembers(current => current.map(item =>
              item.id === member.id ? {...item, mustVote: data.checked ?? false} : item))} /></Table.Cell>
            <Table.Cell collapsing><Button type="button" basic negative icon="trash" aria-label={t('Remove')}
              onClick={() => setMembers(current => current.filter(item => item.id !== member.id))} /></Table.Cell>
          </Table.Row>)}</Table.Body><Table.Footer fullWidth><Table.Row><Table.HeaderCell>
            <Dropdown fluid search selection allowAdditions value={memberName} options={countryOptions}
              onAddItem={(_event, data) => setMemberName(String(data.value))}
              onChange={(_event, data) => setMemberName(String(data.value))} />
          </Table.HeaderCell><Table.HeaderCell><Dropdown fluid selection value={rank} options={RANKS.map(value => ({key: value, value, text: t(value)}))}
            onChange={(_event, data) => setRank(data.value as SeatRank)} /></Table.HeaderCell>
          <Table.HeaderCell><Checkbox toggle checked={canVote} onChange={(_event, data) => setCanVote(data.checked ?? false)} /></Table.HeaderCell>
          <Table.HeaderCell><Checkbox toggle checked={mustVote} onChange={(_event, data) => setMustVote(data.checked ?? false)} /></Table.HeaderCell>
          <Table.HeaderCell><Button type="button" basic primary icon="plus" disabled={!memberName.trim() || duplicateMember} onClick={() => {
            const country = selectedMemberCountry; const shown = country ? localizedDisplayName(country.names, country.defaultLanguage) : memberName.trim();
            setMembers(current => [...current, {id: draftId('member'), stableKey: country?.stableKey ?? draftId('member'), names: country?.names ?? {[displayLanguage]: shown},
              defaultLanguage: country?.defaultLanguage ?? displayLanguage, rank, canVote, hasVeto: rank === 'VETO' && canVote, mustVote,
              sortOrder: current.length, flag: country?.flag ?? {type: 'EMOJI', value: '🏳️'}}]); setMemberName(''); setSaved(false);}} /></Table.HeaderCell>
          </Table.Row></Table.Footer></Table>
          {members.length === 0 && <Message warning content={t('Add at least one committee member')} />}<Message success content={t('Template saved')} />
          {error && <Message error content={error} onDismiss={() => setError(undefined)} />}
          <Button type="submit" primary disabled={!name.trim() || members.length === 0 || !selectedCountry}><Icon name="save" />{t('Save template')}</Button>
          {selectedId && <Button type="button" negative basic floated="right" onClick={() => setDeleteOpen(true)}><Icon name="trash" />{t('Delete template')}</Button>}
        </Form></Segment></Grid.Column></Grid>
    <Confirm open={deleteOpen} header={t('Delete template?')} content={t('Are you sure that you want to delete this template?')}
      cancelButton={t('Cancel')} confirmButton={t('Delete')} onCancel={() => setDeleteOpen(false)} onConfirm={() => void remove()} />
  </Container>;
}

export function TemplatePreview({template}: {template?: CommitteeTemplate}) {
  if (!template) return <p className="template-preview-empty">{t('Select a template to see which members will be added')}</p>;
  return <div className="template-preview">{template.members.map(member => <div className="template-preview-item" key={member.id}>
    <FlagDisplay flag={member.flag} /><span>{localizedDisplayName(member.names, member.defaultLanguage)}</span>
    <span className="template-preview-rank">{t(member.rank)}</span></div>)}</div>;
}
