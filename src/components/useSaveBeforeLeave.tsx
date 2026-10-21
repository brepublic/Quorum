import * as React from 'react';
import {useHistory} from 'react-router-dom';
import {Confirm} from 'semantic-ui-react';
import {t} from '../i18n';

/** Flush a draft before navigation; retain a way to discard it if saving fails. */
export function useSaveBeforeLeave(dirty: boolean, save: () => Promise<boolean>) {
  const history = useHistory(); const latest = React.useRef(save); latest.current = save;
  const [leave, setLeave] = React.useState<{proceed(): void; cancel(): void}>();
  React.useEffect(() => {
    if (!dirty) return;
    let moving = false;
    const unblock = history.block((location, action) => {
      if (moving) return false;
      moving = true;
      const proceed = () => {
        unblock();
        if (action === 'REPLACE') history.replace(location); else history.push(location);
      };
      const failed = () => setLeave({proceed, cancel: () => {moving = false;}});
      void latest.current().then(saved => {if (saved) proceed(); else failed();}, failed);
      return false;
    });
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn);
    return () => {unblock(); window.removeEventListener('beforeunload', warn);};
  }, [dirty, history]);
  return <Confirm open={Boolean(leave)} header={t('Discard unsaved changes?')}
    content={t('Your changes could not be saved.')}
    cancelButton={t('Keep editing')} confirmButton={{content:t('Discard changes'),negative:true,primary:false}}
    onCancel={() => {leave?.cancel();setLeave(undefined);}}
    onConfirm={() => {leave?.proceed();setLeave(undefined);}} />;
}
