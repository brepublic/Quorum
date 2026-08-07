import * as React from 'react';
import { Button, Segment, Header, List, Container } from 'semantic-ui-react';
import { CLIENT_VERSION, VersionLink } from '../components/Footer';
import { Helmet } from 'react-helmet';
import { t } from '../i18n';

export const KeyboardShortcutList = () => (
  <List>
    <List.Item>
      <Button size="mini">
        Alt
      </Button>
      <Button size="mini">
        N
      </Button>
      {t('Next speaker')}
    </List.Item>
    <List.Item>
      <Button size="mini">
        Alt
      </Button>
      <Button size="mini">
        S
      </Button>
      {t('Toggle speaker timer')}
    </List.Item>
    <List.Item>
      <Button size="mini">
        Alt
      </Button>
      <Button size="mini">
        C
      </Button>
      {t('Toggle caucus timer')}
    </List.Item>
  </List>
);

export default class Help extends React.PureComponent<{}, {}> {
  gpl = ( 
    <a href="https://github.com/MaxwellBo/Muncoordinated-2/blob/master/LICENSE">
      GNU GPLv3
    </a>
  );

  render() {
    const { gpl } = this;

    return (
      <Container text style={{ padding: '1em 0em' }}>
        <Helmet>
          <title>{`${t('Help')} - Muncoordinated`}</title>
        </Helmet>
        <Header as="h3" attached="top">{t('Keyboard shortcuts')}</Header>
        <Segment attached="bottom">
        <KeyboardShortcutList />
        </Segment>
        <Header as="h3" attached="top">{t('Bug reporting & help requests')}</Header>
        <Segment attached="bottom">
          {t('In the event that a bug or issue crops up, follow these steps:')}
          <br />
          <List ordered>
            <List.Item>
              {t('Create an issue on the')} <a href="https://github.com/MaxwellBo/Muncoordinated-2/issues">
                {t('Muncoordinated issue tracking page')}
              </a>. {t('You can also use this for help requests regarding the app.')}
            </List.Item>
            <List.Item>
              {t('Describe what you intended to do')}
            </List.Item>
            <List.Item>
              {t('Describe what happened instead')}
            </List.Item>
            <List.Item>
              {t("List the version of the app you're using")} (<VersionLink version={CLIENT_VERSION} />)
            </List.Item>
            <List.Item>
              {t('List the time, date, and browser that you were using when this occurred')}
            </List.Item>
          </List>
        </Segment>
        <Header as="h3" attached="top">{t('License')}</Header>
        <Segment attached="bottom">
          {t('Muncoordinated is licensed under')} {gpl}
        </Segment>
        <Header as="h3" attached="top">{t('Social media')}</Header>
        <Segment attached="bottom">
          {t('Want to meet other Muncoordinators? Visit')} <a href="https://github.com/MaxwellBo/Muncoordinated-2/discussions">{t("The Muncoordinator's Discussion Space")}</a>.
        </Segment>
      </Container>
    );
  }
}
