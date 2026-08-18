import * as React from 'react';
import type {FlagSnapshot} from '@quorum/contracts';

function StandardCountryFlag({value}: {value: string}) {
  const code = value.trim().toLowerCase();
  const [failedCode, setFailedCode] = React.useState<string | null>(null);

  if (!code || failedCode === code) {
    return <span className={`country-flag-display fi fi-${code}`} aria-hidden="true" />;
  }

  return <span className="country-flag-display" aria-hidden="true">
    <img className="country-flag-display-image" src={`/flags/${encodeURIComponent(code)}.svg`} alt=""
      onError={() => setFailedCode(code)} />
  </span>;
}

export function CountryFlagDisplay({flag}: {flag: FlagSnapshot}) {
  if (flag.type === 'IMAGE') return <span className="country-flag-display" aria-hidden="true">
    <img className="country-flag-display-image" src={flag.value} alt="" />
  </span>;
  if (flag.type === 'STANDARD') return <StandardCountryFlag value={flag.value} />;
  return <span className="country-flag-display country-flag-display-emoji" aria-hidden="true">{flag.value}</span>;
}
