import * as React from 'react';
import { Divider, Header, Input, List, Segment } from 'semantic-ui-react';
import {CommitteeID} from "../models/committee";
import {StrawpollID} from "../models/strawpoll";
import { t } from '../i18n';

function CopyableText(props: {
  value: string
}) {
  const [message, setMessage] = React.useState<string>(t('Copy'));

  const copy = () => {
    // We have to try-catch because this API might not be available
    try {
      navigator.clipboard.writeText(props.value)
        .then(() => {
          setMessage(t('Copied!'))
          setTimeout(() => setMessage(t('Copy')), 3000)
        })
        .catch(() => {
          setMessage(t('Please copy manually'))
        })
    } catch (e) {
      setMessage(t('Please copy manually'))
    }
  }

  return (
      <Input fluid
        value={props.value}
        action={{
          labelPosition: 'right',
          icon: 'copy outline',
          content: message,
          onClick: copy
        }}
      />
  );
}

export function CommitteeShareHint(props: {
  committeeID: CommitteeID;
}) {
  const hostname = window.location.hostname;
  const { committeeID } = props;
  const url = `${hostname}/committees/${committeeID}`;

  return (
    <Segment>
      <Header size='medium'>{t("Here's the shareable link to your committee")}</Header>
      <CopyableText value={url} />

      <Divider hidden />

      {t('Copy and send this to your delegates, and they will be able to:')}

      <VerboseShareCapabilities />
      
    </Segment>
  );
}

export function ShareCapabilities() {
  return (
      <List bulleted>
        <List.Item>{t('Upload files')}</List.Item>
        <List.Item>{t("Add themselves to speakers' lists")}</List.Item>
        <List.Item>{t('Add and edit amendments on resolutions')}</List.Item>
        <List.Item>{t('Propose motions')}</List.Item>
        <List.Item>{t('Vote on motions')}</List.Item>
        <List.Item>{t('Vote on strawpolls')}</List.Item>
      </List>
  )
}

export function VerboseShareCapabilities() {
  return (
      <List bulleted>
        <List.Item>{t('Upload files')}</List.Item>
        <List.Item>{t("Add themselves to speakers' lists that have the Delegates can queue flag enabled")}</List.Item>
        <List.Item>{t('Add and edit amendments on resolutions that have the Delegates can amend flag enabled')}</List.Item>
        <List.Item>{t('Propose motions that have the Delegates can propose motions flag enabled')}</List.Item>
        <List.Item>{t('Vote on motions that have the Delegates can vote on motions flag enabled')}</List.Item>
        <List.Item>{t('Vote on strawpolls')}</List.Item>
      </List>
  )
}

export function StrawpollShareHint(props: {
  committeeID: CommitteeID;
  strawpollID: StrawpollID;
}) {
  const hostname = window.location.hostname;
  const { committeeID, strawpollID } = props;
  const url = `${hostname}/committees/${committeeID}/strawpolls/${strawpollID}`;
  return (
    <Segment>
      <Header size='small'>{t("Here's the shareable link to your strawpoll")}</Header>
      <CopyableText value={url} />
    </Segment>
  );
}

export function MotionsShareHint(props: {
  canVote: boolean,
  canPropose: boolean,
  committeeID: CommitteeID;
}) {
  const hostname = window.location.hostname;
  const { committeeID, canVote, canPropose } = props;
  const url = `${hostname}/committees/${committeeID}/motions`;

  let action: string

  if (canVote && canPropose) {
    action = t('vote on and propose motions')
  } else if (canVote) {
    action = t('vote on motions')
  } else if (canPropose) {
    action = t('propose motions')
  } else {
    action = t('vote on and propose motions')
  }

  return (
    <Segment>
      <Header size='small'>{t("Here's the shareable link to {action}", { action })}</Header>
      <CopyableText value={url} />
    </Segment>
  );
}
