import * as React from 'react';
import {Dropdown, Form, Ref, type DropdownProps, type FormDropdownProps, type FormSelectProps} from 'semantic-ui-react';

/** Keep the menu inside the visible viewport, including when a mobile keyboard is open. */
export function dropdownPlacement(anchor: DOMRect, contentHeight: number) {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const bottom = top + (viewport?.height ?? (document.documentElement.clientHeight || window.innerHeight));
  const navigationBottom = Math.max(top, ...Array.from(document.querySelectorAll<HTMLElement>(
    '.committee-navigation-desktop, .committee-navigation-mobile, .delegate-file-menu, .delegate-file-mobile-menu'), navigation => {
    const rect = navigation.getBoundingClientRect();
    return rect.height > 0 && rect.top < bottom && rect.bottom > top ? rect.bottom : top;
  }));
  const below = Math.max(0, bottom - Math.max(top, anchor.bottom) - 16);
  const above = Math.max(0, Math.min(bottom, anchor.top) - navigationBottom - 16);
  const upward = contentHeight > below && above > below;
  return {upward, maxHeight: upward ? above : below};
}

export function ViewportDropdown({className, onOpen, onClose, ...props}: DropdownProps) {
  const anchorRef = React.useRef<HTMLElement>(null);
  const [open, setOpen] = React.useState(Boolean(props.defaultOpen));
  const isOpen = props.open ?? open;
  const [upward, setUpward] = React.useState(false);
  React.useLayoutEffect(() => {
    if (!isOpen) return;
    const dropdown = anchorRef.current;
    const menu = dropdown?.querySelector<HTMLElement>(':scope > .menu');
    if (!dropdown || !menu) return;
    const placeMenu = () => {
      const placement = dropdownPlacement(dropdown.getBoundingClientRect(), menu.scrollHeight);
      dropdown.style.setProperty('--dropdown-menu-max-height', `${placement.maxHeight}px`);
      setUpward(placement.upward);
    };
    placeMenu();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(placeMenu);
    resizeObserver?.observe(dropdown);
    resizeObserver?.observe(menu);
    const mutationObserver = new MutationObserver(placeMenu);
    mutationObserver.observe(menu, {childList: true, subtree: true, characterData: true});
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    window.visualViewport?.addEventListener('resize', placeMenu);
    window.visualViewport?.addEventListener('scroll', placeMenu);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
      window.visualViewport?.removeEventListener('resize', placeMenu);
      window.visualViewport?.removeEventListener('scroll', placeMenu);
      dropdown.style.removeProperty('--dropdown-menu-max-height');
    };
  }, [isOpen]);
  return <Ref innerRef={anchorRef}><Dropdown {...props} className={`viewport-dropdown ${className ?? ''}`}
    upward={upward} onOpen={(event, data) => {setOpen(true); onOpen?.(event, data);}}
    onClose={(event, data) => {setOpen(false); setUpward(false); onClose?.(event, data);}} /></Ref>;
}

export function ViewportFormSelect(props: FormSelectProps) {
  return <Form.Select {...props} control={ViewportDropdown} selection />;
}

export function ViewportFormDropdown(props: FormDropdownProps) {
  return <Form.Dropdown {...props} control={ViewportDropdown} />;
}
