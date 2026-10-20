import * as React from 'react';
import {act} from 'react';
import {render, unmountComponentAtNode} from 'react-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {saveAs} from 'file-saver';
import {TEMPLATE_BUNDLE_MAX_BYTES, type CountryTemplate} from '@quorum/contracts';
import {templateBundleFixture, templateFlagImage} from '../../../server/src/test/template-bundle-fixture';
import {setLanguage} from '../../i18n';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {useTemplateTransfer} from './TemplateTransfer';

vi.mock('file-saver', () => ({saveAs: vi.fn()}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
beforeEach(() => {
  setLanguage('en');
  container = document.createElement('div'); document.body.append(container);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(24);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(16);
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {configurable: true, value: vi.fn(async () => undefined)});
});
afterEach(() => {
  act(() => {unmountComponentAtNode(container);}); container.remove(); vi.restoreAllMocks(); vi.clearAllMocks();
});
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name)!;
const change = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', {bubbles: true}));
});
async function upload(value: unknown, size?: number) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {configurable: true,
      value: [{name: 'summit.quorum-template.json', size: size ?? text.length, text: async () => text}]});
    input.dispatchEvent(new Event('change', {bubbles: true}));
    await Promise.resolve(); await Promise.resolve();
  });
}
function Harness(props: Parameters<typeof useTemplateTransfer>[0]) {
  const transfer = useTemplateTransfer(props);
  return <>{transfer.importButton}{transfer.exportButton}{transfer.dialogs}</>;
}
async function mount(overrides: Partial<Parameters<typeof useTemplateTransfer>[0]> = {}) {
  const imported = vi.fn(async () => undefined);
  const api = {
    previewTemplateImport: vi.fn(async () => structuredClone(templateBundleFixture)),
    importTemplate: vi.fn(async () => ({countryTemplateId: 'new-country', committeeTemplateId: 'new-committee'})),
    exportTemplate: vi.fn(async () => structuredClone(templateBundleFixture))
  } as unknown as SelfHostedApi;
  const props = {api, kind: 'committee' as const, selectedId: 'committee', dirty: false, busy: false,
    countryTemplates: [{...templateBundleFixture.countryTemplate, id: 'existing-country', key: 'custom:existing-country',
      builtin: false, revision: 1, createdAt: null, updatedAt: null,
      countries: templateBundleFixture.countryTemplate.countries.map(country => ({...country, id: country.stableKey, revision: 1}))}] satisfies CountryTemplate[],
    protect: (action: () => void) => action(), save: vi.fn(async () => true), imported, ...overrides};
  await act(async () => {render(<Harness {...props} />, container);});
  return props;
}

describe('template transfer dialogs', () => {
  it('previews the bundle without writes, allows renaming, and creates a visible dependency with its contents', async () => {
    const props = await mount();
    await act(async () => button('Import template').click());
    await upload(templateBundleFixture);
    expect(props.api.importTemplate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Creates a country template in your manager');
    const fields = [...document.querySelectorAll<HTMLInputElement>('.template-transfer-modal input:not([type=file])')];
    expect(fields.map(item => item.value)).toEqual(['Future summit', 'Future countries (imported)']);
    expect(document.querySelector<HTMLImageElement>('img[src^="data:image/"]')?.src).toBe(templateFlagImage);
    await change(fields[1]!, 'My countries');
    await act(async () => button('Import as new template').click());
    expect(props.api.importTemplate).toHaveBeenCalledWith({...templateBundleFixture,
      countryTemplate: {...templateBundleFixture.countryTemplate,
        names: {...templateBundleFixture.countryTemplate.names, en: 'My countries'}}}, expect.any(String));
    expect(props.imported).toHaveBeenCalledWith({countryTemplateId: 'new-country', committeeTemplateId: 'new-committee'});
  });

  it('retains the exact request and key after an uncertain failure', async () => {
    const props = await mount();
    vi.mocked(props.api.importTemplate).mockRejectedValueOnce(new Error('Lost response'));
    await act(async () => button('Import template').click()); await upload(templateBundleFixture);
    await act(async () => button('Import as new template').click());
    expect(document.querySelector<HTMLInputElement>('.template-transfer-modal input:not([type=file])')?.disabled).toBe(true);
    await act(async () => button('Import as new template').click());
    const calls = vi.mocked(props.api.importTemplate).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
    expect(props.imported).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed, oversized, wrong-kind and undecodable-image files before enabling import', async () => {
    const props = await mount();
    await act(async () => button('Import template').click());
    await upload('{'); expect(button('Import as new template').disabled).toBe(true);
    await upload(templateBundleFixture, TEMPLATE_BUNDLE_MAX_BYTES + 1);
    await upload({...templateBundleFixture, kind: 'country'});
    expect(props.api.previewTemplateImport).not.toHaveBeenCalled();
    vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValueOnce(new Error('Invalid WebP'));
    await upload(templateBundleFixture);
    expect(document.body.textContent).toContain('valid WebP');
    expect(button('Import as new template').disabled).toBe(true);
    expect(props.api.importTemplate).not.toHaveBeenCalled();
  });

  it('saves dirty edits before exporting and downloads the complete portable package', async () => {
    const props = await mount({dirty: true});
    await act(async () => button('Export template').click());
    expect(props.api.exportTemplate).not.toHaveBeenCalled();
    await act(async () => button('Save and continue').click());
    expect(props.save).toHaveBeenCalledTimes(1);
    expect(props.api.exportTemplate).toHaveBeenCalledWith('committee', 'committee');
    await act(async () => button('Download file').click());
    const [blob, filename] = vi.mocked(saveAs).mock.calls[0]!;
    expect(filename).toBe('Future summit.quorum-template.json');
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject; reader.readAsText(blob as Blob);
    });
    expect(JSON.parse(content)).toEqual(templateBundleFixture);
  });

  it('keeps failed saves out of the export path', async () => {
    const props = await mount({dirty: true, save: vi.fn(async () => undefined)});
    await act(async () => button('Export template').click());
    await act(async () => button('Save and continue').click());
    expect(props.api.exportTemplate).not.toHaveBeenCalled(); expect(saveAs).not.toHaveBeenCalled();
  });
});
