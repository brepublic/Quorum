import * as React from 'react';
import { Message, Icon } from 'semantic-ui-react';
import { t } from '../i18n';

interface Props {
  item: string;
  id: string;
}

interface State {
}

export class NotFound extends React.PureComponent<Props, State> {
  componentDidMount() {
    const { item, id } = this.props;
    console.info(`${item} with ID ${id} could not be found`);
  }

  render() {
    const { item, id } = this.props;
    return (
      <Message error icon>
        <Icon name="question" />
        <Message.Content>
          <Message.Header as="h1">{t('Not found')}</Message.Header>
          {t('The {item} you were looking for (ID: {id}) could not be found. It may have been deleted, or the URL you navigated to was incorrect.', {
            item: t(item),
            id
          })}
        </Message.Content>
      </Message>
    );
  }
}
