import {
  Accordion,
  AccordionTitleProps,
  ButtonProps,
  Form,
  Icon,
  Popup
} from 'semantic-ui-react';
import * as React from 'react';
import {useEffect, useMemo, useState} from 'react';
import firebase from 'firebase/compat/app';
import {displayMemberName, MemberFlag, Rank} from '../modules/member';
import {
  CommitteeID,
  pushTemplateMembers,
  Template,
  TemplateMember,
  TEMPLATE_TO_MEMBERS
} from '../models/committee';
import {
  templateDisplayName,
  templateCountryTemplateKey,
  templateMembers,
  UserTemplateData,
  userTemplatesRef
} from '../models/template';
import {t} from '../i18n';
import {DEFAULT_COUNTRY_TEMPLATE_KEY, type CountryTemplateKey} from '../models/country-template';

export interface TemplateChoice {
  key: string;
  name: string;
  members: readonly TemplateMember[];
  countryTemplateKey: CountryTemplateKey;
  custom: boolean;
}

interface TemplatePickerProps {
  label?: string;
  placeholder: string;
  value?: string;
  onChange: (choice?: TemplateChoice) => void;
}

export function TemplatePicker(props: TemplatePickerProps) {
  const [user, setUser] = useState<firebase.User | null>(firebase.auth().currentUser);
  const [customTemplates, setCustomTemplates] = useState<Record<string, UserTemplateData>>({});

  useEffect(() => firebase.auth().onAuthStateChanged(setUser), []);

  useEffect(() => {
    if (!user) {
      setCustomTemplates({});
      return;
    }

    const ref = userTemplatesRef(user.uid);
    const callback = (snapshot: firebase.database.DataSnapshot) =>
      setCustomTemplates(snapshot.val() || {});
    ref.on('value', callback);
    return () => ref.off('value', callback);
  }, [user]);

  const choices = useMemo<TemplateChoice[]>(() => [
    ...Object.values(Template).map(name => ({
      key: `builtin:${name}`,
      name: t(name),
      members: TEMPLATE_TO_MEMBERS[name],
      countryTemplateKey: DEFAULT_COUNTRY_TEMPLATE_KEY,
      custom: false
    })),
    ...Object.entries(customTemplates).map(([id, template]) => ({
      key: `custom:${id}`,
      name: templateDisplayName(template),
      members: templateMembers(template),
      countryTemplateKey: templateCountryTemplateKey(template),
      custom: true
    }))
  ], [customTemplates]);

  return (
    <Form.Dropdown
      className="template-picker-field"
      label={props.label}
      name="template"
      search
      clearable
      fluid
      selection
      placeholder={props.placeholder}
      value={props.value || ''}
      options={choices.map(choice => ({
        key: choice.key,
        value: choice.key,
        text: choice.name,
        description: choice.custom ? t('My template') : t('Built-in')
      }))}
      onChange={(_event, data) =>
        props.onChange(choices.find(choice => choice.key === data.value))
      }
    />
  );
}

export function TemplatePreview(props: { members?: readonly TemplateMember[] }) {
  if (!props.members) {
    return <p className="template-preview-empty">{t('Select a template to see which members will be added')}</p>;
  }

  return (
    <div className="template-preview">
      {props.members.map((member, index) => (
        <div className="template-preview-item" key={`${member.name}-${index}`}>
          <MemberFlag member={member} />
          <span>{displayMemberName(member.name)}</span>
          <span className="template-preview-rank">{t(member.rank ?? Rank.Standard)}</span>
        </div>
      ))}
    </div>
  );
}

export function TemplateAdder(props: { committeeID: CommitteeID }) {
  const [template, setTemplate] = useState<TemplateChoice | undefined>();
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  const openAccordion = (_event: React.MouseEvent<HTMLDivElement>, data: AccordionTitleProps) => {
    setActiveIndex(activeIndex === data.index as number ? -1 : data.index as number);
  };

  const pushTemplate = (event: React.MouseEvent<HTMLButtonElement>, _data: ButtonProps) => {
    event.preventDefault();
    if (template) {
      pushTemplateMembers(props.committeeID, template.members);
      firebase.database().ref('committees').child(props.committeeID).update({
        template: template.name,
        templateKey: template.key,
        countryTemplateKey: template.countryTemplateKey,
        temporaryTemplate: false
      });
    }
  };

  return (
    <Accordion>
      <Accordion.Title active={activeIndex === 0} index={0} onClick={openAccordion}>
        <Icon name="dropdown" />
        {t('Add members from a template (e.g. G20)')}
      </Accordion.Title>
      <Accordion.Content active={activeIndex === 0}>
        <Form>
          <TemplatePicker
            label={t('Template')}
            placeholder={t('Select a template to add')}
            value={template?.key}
            onChange={setTemplate}
          />
          <Popup
            basic
            hoverable
            position="bottom left"
            trigger={(
              <Form.Button
                icon="plus"
                disabled={!template}
                primary
                basic
                onClick={pushTemplate}
              />
            )}
          >
            <Popup.Content>
              <TemplatePreview members={template?.members} />
            </Popup.Content>
          </Popup>
        </Form>
      </Accordion.Content>
    </Accordion>
  );
}
