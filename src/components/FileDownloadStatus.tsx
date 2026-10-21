import * as React from 'react';
import {useLocation} from 'react-router-dom';
import {Button, Message} from 'semantic-ui-react';
import {downloadActivity} from '../services/file-download';
import {t, useLanguage} from '../i18n';

export function FileDownloadStatus() {
  useLanguage(); const {pathname} = useLocation();
  const count = React.useSyncExternalStore(downloadActivity.subscribe, downloadActivity.count);
  React.useEffect(() => () => downloadActivity.cancel(), [pathname]);
  return count ? <Message info role="status" className="file-download-status">
    {t('Downloading…')} <Button size="small" onClick={() => downloadActivity.cancel()}>{t('Cancel download')}</Button>
  </Message> : null;
}
