import * as React from 'react';
import {Dropdown, Icon} from 'semantic-ui-react';
import {ViewportDropdown} from './ViewportDropdown';
import {t, useLanguage} from '../i18n';
import './chair-agent-download.css';

export interface ChairAgentRelease {
  schemaVersion: 1;
  serverVersion: string;
  commit: string;
  agentVersion: string;
  releaseUrl: string;
  platforms: Record<'windows' | 'linux', {file: string; url: string; size: number; sha256: string}>;
}

declare const __CHAIR_AGENT_RELEASE__: ChairAgentRelease | null;

/** The release workflow embeds the same manifest and installers in the website image. */
export function ChairAgentDownload({release = __CHAIR_AGENT_RELEASE__}: {release?: ChairAgentRelease | null}) {
  useLanguage();
  const [open, setOpen] = React.useState(false);
  const handleKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    const trigger = event.currentTarget;
    const links = Array.from(trigger.querySelectorAll<HTMLAnchorElement>('a[href]'));
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus();
    } else if (event.key === 'Enter' && event.target instanceof HTMLAnchorElement) {
      event.stopPropagation(); // Preserve native link activation instead of Dropdown's value selection.
    } else if ((event.key === 'Enter' || event.key === ' ') && event.target === trigger) {
      event.preventDefault(); event.stopPropagation(); trigger.click();
    } else if (trigger.classList.contains('active') && links.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const current = links.indexOf(document.activeElement as HTMLAnchorElement);
      const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : links.length - 1)
        : (current + (event.key === 'ArrowDown' ? 1 : links.length - 1)) % links.length;
      links[next].focus();
    }
  };
  return <ViewportDropdown button basic className="chair-agent-download" icon="chevron down"
    open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} selectOnBlur={false} closeOnBlur={false} openOnFocus={false}
    onBlur={(event: React.FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}
    aria-label={t('Download Chair Agent')} onKeyDownCapture={handleKeys}
    trigger={<span><Icon name="download" />{t('Download Chair Agent')}</span>}>
    <Dropdown.Menu>
      <Dropdown.Header content={t('Choose operating system')} />
      {release ? <>
        {(['windows', 'linux'] as const).map(platform => <a className="item" key={platform}
          href={release.platforms[platform].url} download={release.platforms[platform].file}>
          <span className="chair-agent-platform-icon"><Icon name={platform} /></span>
          <span className="chair-agent-platform-copy"><span>{platform === 'windows' ? 'Windows' : 'Linux'}</span>
            <small>{platform === 'windows' ? `X86-64 · ${t('EXE installer')}` : 'x86_64 · AppImage'}</small></span>
          <Icon className="chair-agent-download-arrow" name="download" />
        </a>)}
        <Dropdown.Divider />
        <a className="item chair-agent-release-link" href={release.releaseUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="github" />{t('View this release on GitHub')}<Icon name="external alternate" />
        </a>
      </> : <Dropdown.Item disabled text={t('Installers are unavailable for this build.')} />}
    </Dropdown.Menu>
  </ViewportDropdown>;
}
