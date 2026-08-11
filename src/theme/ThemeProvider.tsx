import * as React from 'react';
import {createPortal} from 'react-dom';
import {useLocation} from 'react-router-dom';
import {saveAs} from 'file-saver';
import {
  Button,
  Dropdown,
  Form,
  Header,
  Icon,
  Message,
  Modal
} from 'semantic-ui-react';
import {t} from '../i18n';
import {
  classifyThemeRoute,
  DEFAULT_THEME,
  DEFAULT_THEME_ID,
  MAX_THEME_FILE_BYTES,
  parseThemePackage,
  serializeThemePackage,
  themeFileName,
  ThemePackage
} from './theme-package';
import './theme-system.css';

const THEMES_STORAGE_KEY = 'quorum-themes-v1';
const ACTIVE_THEME_STORAGE_KEY = 'quorum-active-theme-v1';
const THEME_STYLE_ID = 'quorum-active-theme-styles';

const COMPONENT_HOOKS: ReadonlyArray<readonly [string, string]> = [
  ['.ui.button', 'button'],
  ['.ui.buttons', 'button-group'],
  ['.ui.container', 'container'],
  ['.ui.menu', 'menu'],
  ['.ui.form', 'form'],
  ['.ui.table', 'table'],
  ['.ui.segment', 'segment'],
  ['.ui.modal', 'modal'],
  ['.ui.message', 'message'],
  ['.ui.dropdown', 'dropdown'],
  ['.ui.input', 'input'],
  ['.ui.checkbox', 'checkbox'],
  ['.ui.grid', 'grid'],
  ['.ui.card, .ui.cards', 'card'],
  ['.ui.header', 'heading'],
  ['.ui.statistic, .ui.statistics', 'statistic'],
  ['.ui.progress', 'progress'],
  ['.ui.label', 'label'],
  ['.ui.feed', 'feed'],
  ['.ui.list', 'list'],
  ['.ui.sidebar', 'sidebar']
];

function loadInstalledThemes(): ThemePackage[] {
  try {
    const source = window.localStorage.getItem(THEMES_STORAGE_KEY);
    if (!source) return [];
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      try {
        return [parseThemePackage(JSON.stringify(item))];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function loadActiveThemeId(themes: ThemePackage[]): string {
  try {
    const saved = window.localStorage.getItem(ACTIVE_THEME_STORAGE_KEY);
    return themes.some(theme => theme.manifest.id === saved) ? saved! : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function storeActiveThemeId(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_THEME_STORAGE_KEY, id);
  } catch {
    // The active theme still works for this page session when storage is unavailable.
  }
}

function applyComponentHooks(root: HTMLElement) {
  root.querySelectorAll('[data-theme-component]').forEach(element => {
    element.removeAttribute('data-theme-component');
  });
  COMPONENT_HOOKS.forEach(([selector, token]) => {
    root.querySelectorAll(selector).forEach(element => {
      const tokens = new Set((element.getAttribute('data-theme-component') ?? '').split(/\s+/).filter(Boolean));
      tokens.add(token);
      element.setAttribute('data-theme-component', [...tokens].join(' '));
    });
  });
}

function ThemeManager(props: {
  activeTheme: ThemePackage;
  activeThemeId: string;
  themes: ThemePackage[];
  onActivate: (id: string) => void;
  onImport: (source: string) => ThemePackage;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<{error?: boolean; text: string}>();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const options = props.themes.map(theme => ({
    key: theme.manifest.id,
    value: theme.manifest.id,
    text: `${theme.manifest.id === DEFAULT_THEME_ID ? t('Quorum Default') : theme.manifest.name} · ${theme.manifest.version}`
  }));

  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_THEME_FILE_BYTES) {
        throw new Error(t('Theme file is too large. The maximum size is 3 MB.'));
      }
      const theme = props.onImport(await file.text());
      setNotice({text: t('Imported and applied theme {name}.', {name: theme.manifest.name})});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({error: true, text: t(message)});
    }
  };

  const exportTheme = () => {
    const blob = new Blob([serializeThemePackage(props.activeTheme)], {type: 'application/json;charset=utf-8'});
    saveAs(blob, themeFileName(props.activeTheme));
    setNotice({text: t('Theme download started.')});
  };

  const removeTheme = () => {
    try {
      props.onRemove(props.activeThemeId);
      setNotice({text: t('Theme removed. The default theme is now active.')});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({error: true, text: t(message)});
    }
  };

  return <div id="quorum-theme-portal" className="quorum-theme-portal">
    <Button
      className="quorum-theme-launcher"
      circular
      icon
      aria-label={t('Appearance themes')}
      title={t('Appearance themes')}
      onClick={() => {
        setNotice(undefined);
        setOpen(true);
      }}
    >
      <Icon name="paint brush" />
    </Button>
    <Modal
      className="quorum-theme-manager"
      closeIcon
      mountNode={document.body}
      onClose={() => setOpen(false)}
      open={open}
      size="small"
    >
      <Header icon="paint brush" content={t('Appearance themes')} />
      <Modal.Content>
        <p>{t('Themes can completely restyle and rearrange the interface, but cannot change Quorum data or behavior.')}</p>
        <Form>
          <Form.Field>
            <label>{t('Active theme')}</label>
            <Dropdown
              fluid
              selection
              options={options}
              value={props.activeThemeId}
              onChange={(_, data) => {
                props.onActivate(String(data.value));
                setNotice(undefined);
              }}
            />
          </Form.Field>
        </Form>
        <div className="quorum-theme-summary">
          <strong>{props.activeThemeId === DEFAULT_THEME_ID ? t('Quorum Default') : props.activeTheme.manifest.name}</strong>
          <span>{t('Version')} {props.activeTheme.manifest.version} · {props.activeTheme.manifest.author}</span>
          {props.activeTheme.manifest.description && <p>{props.activeThemeId === DEFAULT_THEME_ID
            ? t('The built-in Quorum interface. It inherits the application styles without adding overrides.')
            : props.activeTheme.manifest.description}</p>}
        </div>
        {notice && <Message error={notice.error} positive={!notice.error} content={notice.text} />}
        <Message info content={t('Imported themes stay in this browser. Theme files contain CSS only and never write to Firebase.')} />
        <input
          ref={inputRef}
          className="quorum-theme-file-input"
          type="file"
          accept=".json,.quorum-theme.json,application/json"
          onChange={importFile}
        />
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={() => inputRef.current?.click()} icon="upload" content={t('Import theme')} />
        <Button onClick={exportTheme} icon="download" content={t('Export active theme')} />
        <Button
          negative
          basic
          disabled={props.activeThemeId === DEFAULT_THEME_ID}
          onClick={removeTheme}
          icon="trash"
          content={t('Remove theme')}
        />
        <Button primary onClick={() => setOpen(false)} content={t('Done')} />
      </Modal.Actions>
    </Modal>
  </div>;
}

export function ThemeProvider(props: React.PropsWithChildren) {
  const location = useLocation();
  const [installedThemes, setInstalledThemes] = React.useState<ThemePackage[]>(loadInstalledThemes);
  const [activeThemeId, setActiveThemeId] = React.useState(() => loadActiveThemeId(installedThemes));
  const allThemes = React.useMemo(() => [DEFAULT_THEME, ...installedThemes], [installedThemes]);
  const activeTheme = allThemes.find(theme => theme.manifest.id === activeThemeId) ?? DEFAULT_THEME;
  const route = classifyThemeRoute(location.pathname);

  const persistThemes = React.useCallback((themes: ThemePackage[]) => {
    try {
      window.localStorage.setItem(THEMES_STORAGE_KEY, JSON.stringify(themes));
    } catch {
      throw new Error('Could not save the theme in this browser. Free some site storage and try again.');
    }
    setInstalledThemes(themes);
  }, []);

  const activate = React.useCallback((id: string) => {
    const nextId = [DEFAULT_THEME, ...installedThemes].some(theme => theme.manifest.id === id)
      ? id
      : DEFAULT_THEME_ID;
    storeActiveThemeId(nextId);
    setActiveThemeId(nextId);
  }, [installedThemes]);

  const importTheme = React.useCallback((source: string) => {
    const theme = parseThemePackage(source);
    if (theme.manifest.id === DEFAULT_THEME_ID) {
      storeActiveThemeId(DEFAULT_THEME_ID);
      setActiveThemeId(DEFAULT_THEME_ID);
      return DEFAULT_THEME;
    }
    const nextThemes = [...installedThemes.filter(item => item.manifest.id !== theme.manifest.id), theme];
    persistThemes(nextThemes);
    storeActiveThemeId(theme.manifest.id);
    setActiveThemeId(theme.manifest.id);
    return theme;
  }, [installedThemes, persistThemes]);

  const removeTheme = React.useCallback((id: string) => {
    if (id === DEFAULT_THEME_ID) return;
    persistThemes(installedThemes.filter(theme => theme.manifest.id !== id));
    storeActiveThemeId(DEFAULT_THEME_ID);
    setActiveThemeId(DEFAULT_THEME_ID);
  }, [installedThemes, persistThemes]);

  React.useEffect(() => {
    let style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = THEME_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = activeTheme.css ? `@scope (#quorum-app) {\n${activeTheme.css}\n}` : '';
    document.documentElement.dataset.quorumTheme = activeTheme.manifest.id;
    document.documentElement.dataset.quorumThemeScheme = activeTheme.manifest.colorScheme ?? 'auto';
    return () => {
      style!.textContent = '';
    };
  }, [activeTheme]);

  React.useEffect(() => {
    const mountNode = document.getElementById('quorum-theme-overlays');
    if (!mountNode) return;
    const modalComponent = Modal as typeof Modal & {defaultProps?: Record<string, unknown>};
    const previousDefaultProps = modalComponent.defaultProps;
    modalComponent.defaultProps = {...previousDefaultProps, mountNode};
    return () => {
      modalComponent.defaultProps = previousDefaultProps;
    };
  }, []);

  React.useEffect(() => {
    const root = document.getElementById('quorum-app');
    if (!root) return;
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        applyComponentHooks(root);
      });
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(root, {childList: true, subtree: true, attributes: true, attributeFilter: ['class']});
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

  return <>
    <div
      id="quorum-app"
      data-theme-page={route.page}
      data-theme-section={route.section}
      data-theme-id={activeTheme.manifest.id}
      data-theme-color-scheme={activeTheme.manifest.colorScheme ?? 'auto'}
    >
      {props.children}
      <div id="quorum-theme-overlays" data-theme-component="overlay-root" />
    </div>
    {createPortal(<ThemeManager
      activeTheme={activeTheme}
      activeThemeId={activeTheme.manifest.id}
      themes={allThemes}
      onActivate={activate}
      onImport={importTheme}
      onRemove={removeTheme}
    />, document.body)}
  </>;
}
