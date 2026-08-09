import * as React from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';
import firebase from 'firebase/compat/app';
import {Form} from 'semantic-ui-react';
import {
  CountryData,
  CountryTemplateData,
  CountryTemplateKey,
  countryTemplateDisplayName,
  DEFAULT_COUNTRY_TEMPLATE_KEY,
  DEFAULT_COUNTRY_TEMPLATE,
  isoCodeToEmoji,
  userCountryTemplatesRef
} from '../models/country-template';
import {t} from '../i18n';
import {FlagDisplay, nameToCountryOption, VectorCountryFlag} from '../modules/member';

export interface CountryTemplateChoice {
  key: CountryTemplateKey;
  name: string;
  template: CountryTemplateData;
  custom: boolean;
}

export const DEFAULT_COUNTRY_TEMPLATE_CHOICE: CountryTemplateChoice = {
  key: DEFAULT_COUNTRY_TEMPLATE_KEY,
  name: countryTemplateDisplayName(DEFAULT_COUNTRY_TEMPLATE),
  template: DEFAULT_COUNTRY_TEMPLATE,
  custom: false
};

export function CountryTemplatePicker(props: {
  value?: string;
  onChange: (choice: CountryTemplateChoice) => void;
  onResolve?: (choice?: CountryTemplateChoice) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
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
    key: `custom:${id}` as CountryTemplateKey,
    name: countryTemplateDisplayName(template),
    template,
    custom: true
  }))], [customTemplates]);
  const onResolveRef = useRef(props.onResolve);
  onResolveRef.current = props.onResolve;

  useEffect(() => {
    onResolveRef.current?.(props.value
      ? choices.find(choice => choice.key === props.value)
      : undefined);
  }, [choices, props.value]);

  return (
    <Form.Dropdown
      className="template-picker-field"
      label={t('Country template')}
      required={props.required}
      disabled={props.disabled}
      search
      fluid
      selection
      value={props.value || ''}
      placeholder={props.placeholder || t('Select a country template')}
      options={choices.map(choice => ({
        key: choice.key,
        value: choice.key,
        text: choice.name,
        description: choice.custom ? t('My template') : t('Built-in')
      }))}
      onChange={(_event, data) => {
        const choice = choices.find(candidate => candidate.key === data.value as CountryTemplateKey);
        if (choice) props.onChange(choice);
      }}
    />
  );
}

export function CountryFlag(props: {country: CountryData}) {
  const option = nameToCountryOption(props.country.name);
  if (props.country.flag?.type === 'emoji' && option
    && props.country.flag.value === isoCodeToEmoji(option.value)) {
    return <VectorCountryFlag code={option.value} />;
  }
  return <FlagDisplay flag={props.country.flag} />;
}
