import * as React from 'react';
import {Message} from 'semantic-ui-react';
import {t, useLanguage} from '../i18n';

/** Display only known capacity measurements; never render arbitrary server diagnostics. */
export function StorageErrorMessage({error, text}: {error: unknown; text: string}) {
  const language = useLanguage();
  const failure = error && typeof error === 'object' ? error as {
    code?: unknown; reason?: unknown; localization?: {reason?: unknown}; requestId?: unknown; details?: unknown;
  } : undefined;
  const reason = failure?.localization?.reason ?? failure?.reason ?? failure?.code;
  if (reason !== 'STORAGE_RESERVE_REQUIRED') return <Message error role="alert" content={text} />;
  const details = failure?.details && typeof failure.details === 'object'
    ? failure.details as Record<string, unknown> : {};
  const bytes = (key: string) => {
    const value = details[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const display = (value: number | undefined) => value === undefined ? '—'
    : `${(value / 1024 ** 3).toLocaleString(language, {maximumFractionDigits: 3})} GiB (${value.toLocaleString(language)} B)`;
  const available = bytes('availableBytes'); const write = bytes('writeBytes');
  const minimum = bytes('minimumFreeBytes');
  const percent = (key: string) => {
    const value = bytes(key);
    return value !== undefined && value <= 100 ? `${value}%` : '—';
  };
  const rows = [
    [t('Cache filesystem capacity'), display(bytes('totalBytes'))],
    [t('Available disk space'), display(available)],
    [t('Cache write size'), display(write)],
    [t('Required free space after writing'), display(minimum)],
    [t('Additional space needed'), display(available !== undefined && write !== undefined && minimum !== undefined
      ? Math.max(0, minimum - available + write) : undefined)],
    [t('Effective free-space rule'), `${display(bytes('storageMinFreeBytes'))} / ${percent('storageMinFreePercent')}`],
    [t('Deployment minimum'), `${display(bytes('hardMinFreeBytes'))} / ${percent('hardMinFreePercent')}`]
  ];
  return <Message error role="alert">
    <p>{text}</p>
    <details style={{overflowWrap: 'anywhere'}}><summary>{t('Technical details')}</summary>
      <p><code>STORAGE_RESERVE_REQUIRED</code></p>
      <dl>{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd style={{overflowWrap: 'anywhere'}}>{value}</dd></React.Fragment>)}</dl>
      <p>{t('The larger of the byte and percentage limits applies. Administrators: check System settings → Cache settings and free space on the cache filesystem.')}</p>
      <p>{t('Deployment limits')}: <code>QUORUM_STORAGE_HARD_MIN_FREE_BYTES</code>, <code>QUORUM_STORAGE_HARD_MIN_FREE_PERCENT</code></p>
      {typeof failure?.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(failure.requestId)
        && <p>{t('Request ID')}: <code>{failure.requestId}</code></p>}
    </details>
  </Message>;
}
