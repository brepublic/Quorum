import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {Dropdown} from 'semantic-ui-react';
import {MemberFlag, membersToOptions, Rank} from './member';
import {CountryFlag} from '../components/country-template';

describe('member flags', () => {
  it('renders a custom image snapshot instead of the fallback country flag', () => {
    const markup = renderToStaticMarkup(<MemberFlag member={{
      name: 'Soviet Union',
      flag: {type: 'image', value: 'data:image/webp;base64,U1NS'}
    }} />);

    expect(markup).toContain('class="country-flag-display-image"');
    expect(markup).toContain('data:image/webp;base64,U1NS');
    expect(markup).not.toContain('fm flag');
  });

  it('renders a custom emoji snapshot', () => {
    const markup = renderToStaticMarkup(<MemberFlag member={{
      name: 'Custom delegation',
      flag: {type: 'emoji', value: '🚩'}
    }} />);

    expect(markup).toContain('🚩');
    expect(markup).toContain('country-flag-display-emoji');
  });

  it('renders standard countries with a scalable SVG flag class', () => {
    const memberMarkup = renderToStaticMarkup(<MemberFlag member="China" />);
    const countryMarkup = renderToStaticMarkup(<CountryFlag country={{
      name: 'China',
      flag: {type: 'emoji', value: '🇨🇳'}
    }} />);

    expect(memberMarkup).toContain('country-flag-display-vector');
    expect(countryMarkup).toContain('country-flag-display-vector');
    expect(memberMarkup).toContain('.svg');
    expect(countryMarkup).toContain('.svg');
    expect(memberMarkup).not.toContain('🇨🇳');
    expect(countryMarkup).not.toContain('🇨🇳');
    expect(memberMarkup).not.toContain('cn flag');
    expect(countryMarkup).not.toContain('cn flag');
  });

  it('renders a custom image in both the selected dropdown value and its menu item', () => {
    const options = membersToOptions({
      ussr: {
        name: 'Soviet Union',
        present: true,
        rank: Rank.Standard,
        voting: false,
        flag: {type: 'image', value: 'data:image/webp;base64,VVNTUg=='}
      }
    });
    const markup = renderToStaticMarkup(
      <Dropdown open selection value={options[0].value} options={options} />
    );

    expect(markup.match(/data:image\/webp;base64,VVNTUg==/g)).toHaveLength(2);
  });
});
