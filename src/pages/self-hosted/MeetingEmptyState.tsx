import * as React from 'react';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import {Link} from 'react-router-dom';
import {Button, Card, Container, Icon} from 'semantic-ui-react';
import {t, useLanguage} from '../../i18n';

export default function MeetingEmptyState({snapshot, className}: {
  snapshot: CommitteeWorkspaceSnapshot; className: string;
}) {
  useLanguage();
  return <Container text className={`${className} meeting-empty-state`}>
    <Card className="meeting-empty-card">
      <Card.Content textAlign="center" className="meeting-empty-card-content">
        <Card.Description>{t(snapshot.meetingEndedAt ? 'Meeting ended' : 'Meeting not in session')}</Card.Description>
        <Button as={Link} to={`/committees/${snapshot.committee.id}/roll-call`} primary>{t('Roll Call')}<Icon name="arrow right" /></Button>
      </Card.Content>
    </Card>
  </Container>;
}
