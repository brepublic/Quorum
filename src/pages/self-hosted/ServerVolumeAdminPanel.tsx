import * as React from 'react';
import {Checkbox, Header, Message, Segment} from 'semantic-ui-react';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {t, apiErrorText} from '../../i18n';

export default function ServerVolumeAdminPanel({api}: {api: SelfHostedApi}) {
  const [policy, setPolicy] = React.useState<{disabled: boolean; revision: number}>();
  const [error, setError] = React.useState<unknown>();
  const [working, setWorking] = React.useState(false);
  React.useEffect(() => {let active = true;
    api.serverVolumePolicy().then(value => {if (active) setPolicy(value);}).catch(e => {if (active) setError(e);});
    return () => {active = false;};
  }, [api]);
  const update = async (disabled: boolean) => {
    if (!policy) return; setWorking(true); setError(undefined);
    try {setPolicy(await api.updateServerVolumePolicy({...policy, disabled}));}
    catch (failure) {setError(failure); try {setPolicy(await api.serverVolumePolicy());} catch { /* keep original failure */ }}
    finally {setWorking(false);}
  };
  return <Segment loading={working}>
    <Header as="h2">{t('Server volume')}</Header>
    {Boolean(error) && <Message error role="alert">{apiErrorText(error)}</Message>}
    <Checkbox toggle label={t('Disable server volume storage')} checked={policy?.disabled ?? false}
      disabled={!policy || working} onChange={(_, data) => void update(Boolean(data.checked))} />
  </Segment>;
}
