import * as React from 'react';
import {Button, Message} from 'semantic-ui-react';
import {Link} from 'react-router-dom';
import {t, apiErrorText} from '../../i18n';
import type {SelfHostedApi} from '../../services/self-hosted-api';

export function useVolumePolicy(api: SelfHostedApi, committeeId: string, enabled = true) {
  const [policy, setPolicy] = React.useState<{disabled: boolean; submissionBlocked: boolean}>();
  const [error, setError] = React.useState<unknown>();
  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = async () => {
      try { const next = await api.storagePolicy(committeeId); if (active) {setPolicy(next); setError(undefined);} }
      catch (failure) {if (active) setError(failure);}
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh);
    return () => {active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh);};
  }, [api, committeeId, enabled]);
  return {disabled: policy?.disabled ?? true, blocked: policy?.submissionBlocked ?? enabled,
    loading: enabled && !policy && !error, error};
}
export function VolumePolicyNotice({blocked, manager, committeeId, error, showAction = true}: {
  blocked: boolean; manager: boolean; committeeId: string; error?: unknown; showAction?: boolean;
}) {
  if (error) return <Message error role="alert">{apiErrorText(error)}</Message>;
  if (!blocked) return null;
  return <Message warning role="status">
    <p>{t(manager ? 'Server volume storage is disabled. Migrate storage before submitting files or new versions.'
      : 'Server volume storage is disabled. Ask a chair to migrate storage before submitting files.')}</p>
    {manager && showAction && <Button primary as={Link} to={`/committees/${committeeId}/posts/storage`}>{t('Migrate storage')}</Button>}
  </Message>;
}
