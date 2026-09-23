import type {Pool} from 'pg';
import type {AuthenticatedSession} from '../modules/identity/store.js';
import {Stage3Service} from '../modules/stage3/service.js';
import {Stage4Service} from '../modules/stage4/service.js';

// Explicit source definitions for integration scenarios that use invented organizations.
// Production creation and immutable-seat validation remain unchanged.
const testMembers: Array<[string, string]> = [["china", "中国"], ["shared", "共享席位"], ["other", "其他席位"], ["invalid", "Invalid"], ["france", "France"], ["one", "First"], ["two", "Second"], ["first", "First"], ["second", "Second"], ["delegate", "Delegate"], ["snapshot", "Snapshot Seat"], ["end-first", "First"], ["member", "Member"], ["s3-member", "S3 Member"], ["delegate-file-seat", "中国"], ["other-delegate", "法国"]];

export async function testCommitteeInput(pool: Pool, auth: AuthenticatedSession,
  input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stage3 = new Stage3Service(pool); const stage4 = new Stage4Service(pool);
  const rules = (await stage3.listRulePackages()).find(item => item.key === 'builtin:beijing-academic')!;
  const result = {...input, committeeLanguage: input.committeeLanguage ?? 'en',
    activeRulePackageVersionId: input.activeRulePackageVersionId ?? rules.versions.at(-1)!.id};
  if (input.committeeTemplateId) {
    const template = (await stage4.listCommitteeTemplates(auth)).find(item => item.id === input.committeeTemplateId)!;
    const countries = (await stage4.listCountryTemplates(auth)).find(item => item.key === template.countryTemplateKey)!;
    return {...result, committeeTemplateRevision: template.revision, countryTemplateRevision: countries.revision};
  }
  if (input.countryTemplateKey && input.countryTemplateKey !== 'builtin:default' || auth.user.isSystemAdmin) {
    const countries = (await stage4.listCountryTemplates(auth)).find(item => item.key === (input.countryTemplateKey ?? 'builtin:default'))!;
    return {...result, countryTemplateKey: countries.key, countryTemplateRevision: countries.revision};
  }
  const countries = await stage4.createCountryTemplate(auth, {
    names: {en: 'Integration directory', 'zh-CN': '集成测试目录'}, defaultLanguage: 'en', countryLanguages: ['en','zh-CN'],
    countries: testMembers.map(([stableKey, name], sortOrder) => ({stableKey, names: {en: name, 'zh-CN': name},
      defaultLanguage: 'en', continent: null, sortOrder, flag: {type: 'EMOJI', value: '🏳️'}}))
  }, 'integration-directory-v1', {requestId: 'integration-directory', sourceIp: '127.0.0.1', userAgent: 'Vitest'});
  return {...result, countryTemplateKey: countries.key, countryTemplateRevision: countries.revision};
}
