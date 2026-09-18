import {apiErrorText} from '../../i18n';
import {t, useLanguage, getLanguage} from '../../i18n';
import * as React from 'react';
import {Prompt} from 'react-router-dom';
import {Button, Form, Header, Select, Message, Segment} from 'semantic-ui-react';
import type {SelfHostedApi} from '../../services/self-hosted-api';

type Config = Awaited<ReturnType<SelfHostedApi['storageCacheStatus']>>['config'];
type ByteField = 'publishedCacheMaxBytes' | 'pendingReviewMaxBytes' | 'pendingReviewCommitteeMaxBytes';
type ByteUnit = 'B' | 'KB' | 'MB' | 'GB';
const byteFields: Array<{key: ByteField; label: string}> = [
  {key: 'publishedCacheMaxBytes', label: "Published cache quota"},
  {key: 'pendingReviewMaxBytes', label: "Total review quota"},
  {key: 'pendingReviewCommitteeMaxBytes', label: "Review quota per committee"}
];
const byteUnits: ByteUnit[] = ['B', 'KB', 'MB', 'GB'];
const defaultByteUnit: ByteUnit = 'MB';
const unitBytes: Record<ByteUnit, number> = {B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3};
const unitOptions = byteUnits.map(unit => ({key: unit, value: unit, text: unit}));
const bytesToDisplayValue = (bytes: number, unit: ByteUnit) => {
  const normalized = bytes / unitBytes[unit];
  return Number.isInteger(normalized) ? String(normalized) : String(Number(normalized.toFixed(6)));
};
const parseDisplayValue = (raw: string, unit: ByteUnit): number | undefined => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * unitBytes[unit]);
};

export default function StorageCacheSettingsPanel({api}: {api: SelfHostedApi}) {
  useLanguage();
  const [config, setConfig] = React.useState<Config>();
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? apiErrorText(failure) : undefined;
  const [displayed, setDisplayed] = React.useState<Record<ByteField, string>>({
    publishedCacheMaxBytes: '', pendingReviewMaxBytes: '', pendingReviewCommitteeMaxBytes: ''
  });
  const [units, setUnits] = React.useState<Record<ByteField, ByteUnit>>({
    publishedCacheMaxBytes: defaultByteUnit, pendingReviewMaxBytes: defaultByteUnit, pendingReviewCommitteeMaxBytes: defaultByteUnit
  });
  const [invalid, setInvalid] = React.useState<Record<ByteField, boolean>>({
    publishedCacheMaxBytes: false, pendingReviewMaxBytes: false, pendingReviewCommitteeMaxBytes: false
  });
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setError(undefined);
    void api.storageCacheStatus().then(value => {if (!active) return;
      setConfig(value.config); setDirty(false); setSaved(false);
      setDisplayed({
        publishedCacheMaxBytes: bytesToDisplayValue(value.config.publishedCacheMaxBytes, defaultByteUnit),
        pendingReviewMaxBytes: bytesToDisplayValue(value.config.pendingReviewMaxBytes, defaultByteUnit),
        pendingReviewCommitteeMaxBytes: bytesToDisplayValue(value.config.pendingReviewCommitteeMaxBytes, defaultByteUnit)
      });
      setUnits({publishedCacheMaxBytes: defaultByteUnit, pendingReviewMaxBytes: defaultByteUnit,
        pendingReviewCommitteeMaxBytes: defaultByteUnit});
      setInvalid({publishedCacheMaxBytes: false, pendingReviewMaxBytes: false, pendingReviewCommitteeMaxBytes: false});
    }, caught => {
      if (active) setError(caught);
    });
    return () => {active = false;};
  }, [api, reload]);
  React.useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {if (dirty) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const save = async () => {
    if (!config) return;
    setSaving(true); setError(undefined); setSaved(false);
    try {const next = await api.updateStorageCacheConfig(config); setConfig(next);
      setDisplayed({
        publishedCacheMaxBytes: bytesToDisplayValue(next.publishedCacheMaxBytes, units.publishedCacheMaxBytes),
        pendingReviewMaxBytes: bytesToDisplayValue(next.pendingReviewMaxBytes, units.pendingReviewMaxBytes),
        pendingReviewCommitteeMaxBytes: bytesToDisplayValue(next.pendingReviewCommitteeMaxBytes, units.pendingReviewCommitteeMaxBytes),
      });
      setDirty(false); setSaved(true);}
    catch (caught) {setError(caught);}
    finally {setSaving(false);}
  };
  const updateSavedBytes = (key: ByteField, raw: string) => {
    const bytes = parseDisplayValue(raw, units[key]);
    setInvalid(current => ({...current, [key]: bytes === undefined}));
    if (!config || bytes === undefined) return;
    setConfig({...config, [key]: bytes});
    setDirty(true);
    setSaved(false);
    setDisplayed(current => ({...current, [key]: raw}));
  };
  const updateUnit = (key: ByteField, unit: ByteUnit) => {
    const bytes = parseDisplayValue(displayed[key], units[key]) ?? config?.[key];
    setUnits(current => ({...current, [key]: unit}));
    if (bytes === undefined) return;
    setDisplayed(current => ({...current, [key]: bytesToDisplayValue(bytes, unit)}));
    setInvalid(current => ({...current, [key]: false}));
  };
  const input = (field: (typeof byteFields)[number]) => <Form.Field key={field.key} error={invalid[field.key]}>
    <label>{t(field.label)}</label>
    <Form.Input id={`cache-${field.key}`} type="number" required min={0} step="any"
      value={displayed[field.key]} onChange={(_, data) => updateSavedBytes(field.key, String(data.value))}
      action={<Select compact button options={unitOptions} value={units[field.key]}
        id={`cache-${field.key}-unit`} onChange={(_, data) => updateUnit(field.key, data.value as ByteUnit)} />} />
  </Form.Field>;
  return <div className="self-hosted-cache-settings">
    <Prompt when={dirty} message={t("Discard unsaved cache settings?")} />
    {error && <Message error role="alert" content={error} />}
    {saved && <Message positive role="status" content={t("Saved")} />}
    {!config ? <Segment loading={!error} style={{minHeight: '8em'}}>
      {error && <Button onClick={() => setReload(value => value + 1)}>{t("Retry")}</Button>}
    </Segment> : <Form onSubmit={() => void save()} loading={saving}>
      <Segment>
        <Header as="h2">{t("Cache quotas")}</Header>
        <Form.Group widths="equal">
          {byteFields.map(field => input(field))}
        </Form.Group>
      </Segment>
      <Segment>
        <Header as="h2">{t("Free space reserve")}</Header>
        <Form.Group widths="equal">
          <Form.Input id="cache-storageMinFreeBytes" label={t("Minimum free space (bytes)")} type="number" required min={0} step={1}
            value={config.storageMinFreeBytes} onChange={(_, data) => {setConfig({...config, storageMinFreeBytes: Number(data.value)}); setDirty(true); setSaved(false);}} />
          <Form.Input id="cache-storageMinFreePercent" label={t("Minimum free space (%)")} type="number" required min={0} max={100}
            value={config.storageMinFreePercent} onChange={(_, data) => {setConfig({...config, storageMinFreePercent: Number(data.value)}); setDirty(true); setSaved(false);}} />
        </Form.Group>
      </Segment>
      <Button primary disabled={saving || !dirty || Object.values(invalid).some(value => value)}>{t("Save cache configuration")}</Button>
    </Form>}
  </div>;
}
