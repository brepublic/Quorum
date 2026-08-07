import * as React from 'react';
import {useEffect, useMemo, useState} from 'react';
import firebase from 'firebase/compat/app';
import {
  Button,
  Checkbox,
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
import {
  canonicalCountryName,
  displayMemberName,
  MemberData,
  nameToMemberOption,
  Rank,
  searchCountryOptions
} from '../modules/member';
import {COUNTRY_OPTIONS} from '../constants';
import {makeDropdownOption, meetId} from '../utils';
import {
  deleteUserTemplate,
  putUserTemplate,
  templateDefaultLanguage,
  templateDisplayName,
  UserTemplateData,
  userTemplatesRef
} from '../models/template';
import {
  CountryFlag,
  CountryTemplateChoice,
  CountryTemplatePicker,
  DEFAULT_COUNTRY_TEMPLATE_CHOICE
} from '../components/country-template';
import {countryDisplayName} from '../models/country-template';
import type {DropdownItemProps} from 'semantic-ui-react';

type DraftMember = MemberData & {id: string};
type LocalizedNameDraft = {id: string; language: Language; name: string};
type CountryMemberOption = DropdownItemProps & {memberName: string};

const RANK_OPTIONS = [Rank.Standard, Rank.Veto, Rank.NGO, Rank.Observer].map(makeDropdownOption);

export default function Templates() {
  const displayLanguage = getLanguage();
  const [user, setUser] = useState<firebase.User | null>();
  const [templates, setTemplates] = useState<Record<string, UserTemplateData>>({});
  const [selectedID, setSelectedID] = useState<string>();
  const [name, setName] = useState('');
  const [defaultLanguage, setDefaultLanguage] = useState<Language>(displayLanguage);
  const [nameIsFallback, setNameIsFallback] = useState(false);
  const [localizedNames, setLocalizedNames] = useState<LocalizedNameDraft[]>([]);
  const [members, setMembers] = useState<DraftMember[]>([]);
  const [memberName, setMemberName] = useState(COUNTRY_OPTIONS[0].text);
  const [customCountries, setCustomCountries] = useState<CountryMemberOption[]>([]);
  const [countryTemplate, setCountryTemplate] = useState<CountryTemplateChoice>(DEFAULT_COUNTRY_TEMPLATE_CHOICE);
  const [rank, setRank] = useState(Rank.Standard);
  const [present, setPresent] = useState(true);
  const [voting, setVoting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => firebase.auth().onAuthStateChanged(setUser), []);

  useEffect(() => {
    if (!user) {
      setTemplates({});
      return;
    }

    const ref = userTemplatesRef(user.uid);
    const callback = (snapshot: firebase.database.DataSnapshot) => setTemplates(snapshot.val() || {});
    ref.on('value', callback);
    return () => ref.off('value', callback);
  }, [user]);

  const countryOptions = useMemo<CountryMemberOption[]>(() => [
    ...customCountries,
    ...Object.entries(countryTemplate.template.countries || {}).map(([id, country]) => ({
      key: `${countryTemplate.key}:${id}`,
      value: `${countryTemplate.key}:${id}`,
      text: countryDisplayName(country),
      content: <span className="country-template-option"><CountryFlag country={country} />{countryDisplayName(country)}</span>,
      memberName: country.name
    }))
  ], [customCountries, countryTemplate]);

  const startNew = () => {
    setSelectedID(undefined);
    setName('');
    setDefaultLanguage(displayLanguage);
    setNameIsFallback(false);
    setLocalizedNames([]);
    setMembers([]);
    setSaved(false);
    setError(undefined);
  };

  const selectTemplate = (id: string) => {
    const template = templates[id];
    const templateLanguage = templateDefaultLanguage(template);
    const exactDisplayName = template.names?.[displayLanguage]?.trim()
      || (displayLanguage === templateLanguage ? template.name.trim() : '');
    setSelectedID(id);
    setDefaultLanguage(templateLanguage);
    setName(exactDisplayName || templateDisplayName(template, displayLanguage));
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
    setMembers(Object.entries(template.members || {}).map(([memberID, member]) => ({
      id: memberID,
      ...member
    })));
    setSaved(false);
    setError(undefined);
  };

  const addCustomCountry = (value: string) => {
    const option = nameToMemberOption(value);
    if (!countryOptions.some(country => country.memberName === option.text)) {
      setCustomCountries(current => [{...option, memberName: option.text}, ...current.filter(country => country.value !== option.value)]);
    }
    setMemberName(option.text);
  };

  const addMember = () => {
    if (members.some(member => canonicalCountryName(member.name) === canonicalCountryName(memberName))) {
      return;
    }

    setMembers(current => [...current, {
      id: meetId(),
      name: memberName,
      rank,
      present,
      voting
    }]);
    setSaved(false);
  };

  const updateMember = <K extends keyof MemberData>(id: string, field: K, value: MemberData[K]) => {
    setMembers(current => current.map(member => member.id === id ? {...member, [field]: value} : member));
    setSaved(false);
  };

  const unusedLanguages = SUPPORTED_LANGUAGES.filter(
    language => language !== displayLanguage
      && !localizedNames.some(localizedName => localizedName.language === language)
  );

  const addLocalizedName = () => {
    const language = unusedLanguages[0];
    if (!language) {
      return;
    }
    setLocalizedNames(current => [...current, {id: meetId(), language, name: ''}]);
    setSaved(false);
  };

  const updateLocalizedName = (
    id: string,
    update: Partial<Pick<LocalizedNameDraft, 'language' | 'name'>>
  ) => {
    setLocalizedNames(current => current.map(item => item.id === id ? {...item, ...update} : item));
    setSaved(false);
  };

  const save = async () => {
    if (!user || !name.trim() || members.length === 0) {
      return;
    }

    const templateMembers = members.reduce<Record<string, MemberData>>((result, member) => {
      const {id, ...data} = member;
      result[id] = data;
      return result;
    }, {});
    const trimmedName = name.trim();
    const names: Partial<Record<Language, string>> = {};
    if (!nameIsFallback) {
      names[displayLanguage] = trimmedName;
    }
    localizedNames.forEach(localizedName => {
      const value = localizedName.name.trim();
      if (value) {
        names[localizedName.language] = value;
      }
    });
    let savedDefaultLanguage = defaultLanguage;
    if (!names[savedDefaultLanguage]) {
      const availableLanguage = SUPPORTED_LANGUAGES.find(language => !!names[language]);
      if (availableLanguage) {
        savedDefaultLanguage = availableLanguage;
      } else {
        names[displayLanguage] = trimmedName;
        savedDefaultLanguage = displayLanguage;
      }
    }
    const defaultName = names[savedDefaultLanguage] as string;
    try {
      const ref = await putUserTemplate(user.uid, selectedID, {
        name: defaultName,
        defaultLanguage: savedDefaultLanguage,
        names,
        members: templateMembers
      });
      setSelectedID(ref.key ?? selectedID);
      setName(trimmedName);
      setDefaultLanguage(savedDefaultLanguage);
      setNameIsFallback(!names[displayLanguage]);
      setLocalizedNames(current => current.map(item => ({...item, name: item.name.trim()})));
      setSaved(true);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Could not save template'));
    }
  };

  const removeTemplate = async () => {
    if (user && selectedID) {
      try {
        await deleteUserTemplate(user.uid, selectedID);
        setDeleteOpen(false);
        startNew();
      } catch (reason) {
        setDeleteOpen(false);
        setError(reason instanceof Error ? reason.message : t('Could not delete template'));
      }
    }
  };

  const memberAlreadyExists = members.some(
    member => canonicalCountryName(member.name) === canonicalCountryName(memberName)
  );

  return (
    <Container style={{padding: '1em 0 2em'}}>
      <Helmet><title>{`${t('Template editor')} - Muncoordinated`}</title></Helmet>
      <Menu secondary>
        <Menu.Item as="a" href="/onboard">
          <Icon name="arrow left" />{t('Create committee')}
        </Menu.Item>
        <Menu.Item as="a" href="/countries">
          <Icon name="world" />{t('Country manager')}
        </Menu.Item>
        <LanguageMenuItem position="right" />
      </Menu>
      <Header as="h1">{t('Template editor')}</Header>

      {user === undefined && <Segment loading style={{minHeight: 120}} />}
      {user === null && (
        <Grid stackable columns={2}>
          <Grid.Column>
            <Message warning content={t('Log in to manage your templates')} />
          </Grid.Column>
          <Grid.Column><Login allowNewCommittee={false} /></Grid.Column>
        </Grid>
      )}

      {user && (
        <Grid stackable columns={2}>
          <Grid.Column width={5}>
            <Segment>
              <Button primary fluid icon labelPosition="left" onClick={startNew}>
                <Icon name="plus" />{t('New template')}
              </Button>
              <List divided relaxed selection>
                {Object.entries(templates).map(([id, template]) => (
                  <List.Item key={id} active={id === selectedID} onClick={() => selectTemplate(id)}>
                    <Icon name="file alternate outline" />
                    <List.Content>
                      <List.Header>{templateDisplayName(template)}</List.Header>
                      <List.Description>
                        {t('{count} members', {count: Object.keys(template.members || {}).length})}
                      </List.Description>
                    </List.Content>
                  </List.Item>
                ))}
                {Object.keys(templates).length === 0 && (
                  <List.Item><List.Content>{t('No custom templates yet')}</List.Content></List.Item>
                )}
              </List>
            </Segment>
          </Grid.Column>

          <Grid.Column width={11}>
            <Segment>
              <Header as="h2">{selectedID ? t('Edit template') : t('New template')}</Header>
              <Form success={saved} error={!!error} warning={members.length === 0} onSubmit={save}>
                <Form.Input
                  required
                  label={t('Template name')}
                  value={name}
                  onChange={event => {
                    setName(event.currentTarget.value);
                    setNameIsFallback(false);
                    setSaved(false);
                  }}
                  placeholder={t('Enter a template name')}
                />
                <div className="template-localized-names">
                  {localizedNames.map(localizedName => {
                    const languageOptions = LANGUAGE_OPTIONS.filter(option =>
                      option.value !== displayLanguage
                      && (option.value === localizedName.language
                        || !localizedNames.some(item => item.language === option.value))
                    );
                    return (
                      <Form.Group key={localizedName.id} className="template-localized-name-row">
                        <Form.Dropdown
                          label={t('Language')}
                          selection
                          value={localizedName.language}
                          options={languageOptions}
                          onChange={(_event, data) => updateLocalizedName(
                            localizedName.id,
                            {language: data.value as Language}
                          )}
                        />
                        <Form.Input
                          label={t('Template name')}
                          value={localizedName.name}
                          placeholder={t('Enter a template name')}
                          onChange={event => updateLocalizedName(
                            localizedName.id,
                            {name: event.currentTarget.value}
                          )}
                        />
                        <Form.Button
                          type="button"
                          basic
                          negative
                          icon="trash"
                          aria-label={t('Remove')}
                          onClick={() => {
                            setLocalizedNames(current => current.filter(item => item.id !== localizedName.id));
                            setSaved(false);
                          }}
                        />
                      </Form.Group>
                    );
                  })}
                  {unusedLanguages.length > 0 && (
                    <Button
                      type="button"
                      fluid
                      className="add-template-language"
                      onClick={addLocalizedName}
                    >
                      <Icon name="plus" />{t('Other language')}
                    </Button>
                  )}
                </div>
                <CountryTemplatePicker
                  value={countryTemplate.key}
                  onChange={choice => {
                    setCountryTemplate(choice);
                    const firstCountry = Object.values(choice.template.countries || {})[0];
                    if (firstCountry) setMemberName(firstCountry.name);
                  }}
                />
                <Header as="h3">{t('Committee members')}</Header>
                <Table compact celled stackable>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>{t('Country or delegation')}</Table.HeaderCell>
                      <Table.HeaderCell>{t('Rank')}</Table.HeaderCell>
                      <Table.HeaderCell>{t('Present')}</Table.HeaderCell>
                      <Table.HeaderCell>{t('Must Vote')}</Table.HeaderCell>
                      <Table.HeaderCell />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {members.map(member => (
                      <Table.Row key={member.id}>
                        <Table.Cell>{displayMemberName(member.name)}</Table.Cell>
                        <Table.Cell>
                          <Dropdown
                            fluid selection
                            value={member.rank}
                            options={RANK_OPTIONS.map(option => ({...option, text: t(String(option.text))}))}
                            onChange={(_event, data) => updateMember(member.id, 'rank', data.value as Rank)}
                          />
                        </Table.Cell>
                        <Table.Cell collapsing>
                          <Checkbox
                            toggle checked={member.present}
                            onChange={(_event, data) => updateMember(member.id, 'present', data.checked ?? false)}
                          />
                        </Table.Cell>
                        <Table.Cell collapsing>
                          <Checkbox
                            toggle checked={member.voting}
                            onChange={(_event, data) => updateMember(member.id, 'voting', data.checked ?? false)}
                          />
                        </Table.Cell>
                        <Table.Cell collapsing>
                          <Button
                            type="button" basic negative icon="trash"
                            aria-label={t('Remove')}
                            onClick={() => {
                              setMembers(current => current.filter(item => item.id !== member.id));
                              setSaved(false);
                            }}
                          />
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                  <Table.Footer fullWidth>
                    <Table.Row>
                      <Table.HeaderCell>
                        <Dropdown
                          fluid search={searchCountryOptions} selection allowAdditions
                          value={countryOptions.find(option =>
                            canonicalCountryName(option.memberName) === canonicalCountryName(memberName)
                          )?.value || nameToMemberOption(memberName).value}
                          options={countryOptions}
                          onAddItem={(_event, data) => addCustomCountry(String(data.value))}
                          onChange={(_event, data) => {
                            const option = countryOptions.find(country => country.value === data.value);
                            if (option) setMemberName(option.memberName);
                          }}
                        />
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        <Dropdown
                          fluid selection value={rank}
                          options={RANK_OPTIONS.map(option => ({...option, text: t(String(option.text))}))}
                          onChange={(_event, data) => setRank(data.value as Rank)}
                        />
                      </Table.HeaderCell>
                      <Table.HeaderCell><Checkbox toggle checked={present} onChange={(_e, d) => setPresent(d.checked ?? false)} /></Table.HeaderCell>
                      <Table.HeaderCell><Checkbox toggle checked={voting} onChange={(_e, d) => setVoting(d.checked ?? false)} /></Table.HeaderCell>
                      <Table.HeaderCell>
                        <Button type="button" basic primary icon="plus" disabled={memberAlreadyExists} onClick={addMember} />
                      </Table.HeaderCell>
                    </Table.Row>
                  </Table.Footer>
                </Table>
                {members.length === 0 && <Message warning content={t('Add at least one committee member')} />}
                <Message success content={t('Template saved')} />
                {error && <Message error content={error} onDismiss={() => setError(undefined)} />}
                <Button type="submit" primary disabled={!name.trim() || members.length === 0}>
                  <Icon name="save" />{t('Save template')}
                </Button>
                {selectedID && (
                  <Button type="button" negative basic floated="right" onClick={() => setDeleteOpen(true)}>
                    <Icon name="trash" />{t('Delete template')}
                  </Button>
                )}
              </Form>
            </Segment>
          </Grid.Column>
        </Grid>
      )}

      <Confirm
        open={deleteOpen}
        header={t('Delete template?')}
        content={t('Are you sure that you want to delete this template?')}
        cancelButton={t('Cancel')}
        confirmButton={t('Delete')}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={removeTemplate}
      />
    </Container>
  );
}
