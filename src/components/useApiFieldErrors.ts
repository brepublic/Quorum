import * as React from 'react';
import {formatApiError, type ApiFieldError} from '@quorum/contracts';
import {useLanguage} from '../i18n';

/** Associate structured server validation with controls without replacing their drafts. */
export function useApiFieldErrors(failure: unknown) {
  const language = useLanguage();
  const prefix = React.useId();
  const value = failure && typeof failure === 'object' ? failure as {
    fieldErrors?: ApiFieldError[]; localization?: {fieldErrors?: ApiFieldError[]}
  } : undefined;
  const errors = value?.localization?.fieldErrors ?? value?.fieldErrors ?? [];
  const controls = React.useRef(new Map<string, string[]>());
  controls.current.clear();
  const field = (path: string, ...aliases: string[]) => {
    const paths = [path, ...aliases]; const id = `${prefix}-${path}`;
    controls.current.set(id, paths);
    const error = errors.find(item => paths.some(candidate => item.field === candidate || item.field.startsWith(`${candidate}.`)));
    return {id, 'aria-invalid': !!error, error: error ? {content: formatApiError(error, language)} : false};
  };
  React.useEffect(() => {
    if (!errors.length) return;
    for (const error of errors) {
      const match = [...controls.current].find(([, paths]) => paths.some(path => error.field === path || error.field.startsWith(`${path}.`)));
      const control = match && document.getElementById(match[0]);
      if (!control) continue;
      for (let parent = control.parentElement; parent; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      control.scrollIntoView?.({block: 'center'});
      control.focus();
      break;
    }
    // A language switch updates messages without moving focus again.
  }, [failure]);
  return field;
}
