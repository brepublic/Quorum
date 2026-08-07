import * as React from 'react';
import {useEffect, useMemo, useState} from 'react';
import firebase from 'firebase/compat/app';
import {Form} from 'semantic-ui-react';
import {
  CountryData,
  CountryTemplateData,
  countryTemplateDisplayName,
  DEFAULT_COUNTRY_TEMPLATE,
  userCountryTemplatesRef
} from '../models/country-template';
import {t} from '../i18n';

export interface CountryTemplateChoice {
  key: string;
  name: string;
  template: CountryTemplateData;
  custom: boolean;
}

export const DEFAULT_COUNTRY_TEMPLATE_CHOICE: CountryTemplateChoice = {
  key: 'builtin:default',
  name: countryTemplateDisplayName(DEFAULT_COUNTRY_TEMPLATE),
  template: DEFAULT_COUNTRY_TEMPLATE,
  custom: false
};

export function CountryTemplatePicker(props: {
  value?: string;
  onChange: (choice: CountryTemplateChoice) => void;
}) {
  const [user, setUser] = useState<firebase.User | null>(firebase.auth().currentUser);
  const [customTemplates, setCustomTemplates] = useState<Record<string, CountryTemplateData>>({});

  useEffect(() => firebase.auth().onAuthStateChanged(setUser), []);
  useEffect(() => {
    if (!user) {
      setCustomTemplates({});
      return;
    }
    const ref = userCountryTemplatesRef(user.uid);
    const callback = (snapshot: firebase.database.DataSnapshot) => setCustomTemplates(snapshot.val() || {});
    ref.on('value', callback);
    return () => ref.off('value', callback);
  }, [user]);

  const choices = useMemo<CountryTemplateChoice[]>(() => [{
    ...DEFAULT_COUNTRY_TEMPLATE_CHOICE,
    name: countryTemplateDisplayName(DEFAULT_COUNTRY_TEMPLATE)
  }, ...Object.entries(customTemplates).map(([id, template]) => ({
    key: `custom:${id}`,
    name: countryTemplateDisplayName(template),
    template,
    custom: true
  }))], [customTemplates]);

  return (
    <Form.Dropdown
      className="template-picker-field"
      label={t('Country template')}
      search
      fluid
      selection
      value={props.value || DEFAULT_COUNTRY_TEMPLATE_CHOICE.key}
      options={choices.map(choice => ({
        key: choice.key,
        value: choice.key,
        text: choice.name,
        description: choice.custom ? t('My template') : t('Built-in')
      }))}
      onChange={(_event, data) => {
        const choice = choices.find(candidate => candidate.key === data.value);
        if (choice) props.onChange(choice);
      }}
    />
  );
}

export function CountryFlag(props: {country: CountryData}) {
  const flag = props.country.flag;
  if (flag?.type === 'image' && flag.value) {
    return <img className="country-template-flag" src={flag.value} alt="" />;
  }
  return <span className="country-template-flag country-template-flag-emoji">{flag?.value || '🏳️'}</span>;
}
