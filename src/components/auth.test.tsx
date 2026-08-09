import React, {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const authMocks = vi.hoisted(() => {
  const unsubscribe = vi.fn();

  return {
    unsubscribe,
    signOut: vi.fn(),
    onAuthStateChanged: vi.fn((callback: (user: unknown) => void) => {
      callback({uid: 'director-1', email: 'director@example.com'});
      return unsubscribe;
    }),
    once: vi.fn(async () => ({
      val: () => ({
        'committee-1': {name: 'Security Council', topic: 'Peace and security'}
      })
    }))
  };
});

vi.mock('firebase/compat/app', () => ({
  default: {
    auth: () => ({
      onAuthStateChanged: authMocks.onAuthStateChanged,
      signOut: authMocks.signOut
    }),
    database: () => ({
      ref: () => ({
        orderByChild: () => ({
          equalTo: () => ({once: authMocks.once})
        })
      })
    })
  }
}));

import {Login} from './auth';
import {setLanguage} from '../i18n';

describe('committee deletion controls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let login: Login | null;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    setLanguage('zh-CN');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    login = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.querySelectorAll('.ui.page.modals').forEach(modal => modal.remove());
    vi.clearAllMocks();
  });

  const renderLogin = async (allowNewCommittee: boolean) => {
    await act(async () => {
      root.render(<Login ref={instance => { login = instance; }} allowNewCommittee={allowNewCommittee} />);
      await Promise.resolve();
    });
  };

  it('offers the same destructive confirmation in the signed-in page and account-popup variants', async () => {
    await renderLogin(false);
    expect(container.querySelector('button[aria-label="删除委员会“Security Council”"]')).toBeTruthy();

    act(() => login!.requestCommitteeDeletion('committee-1'));
    expect(document.body.textContent).toContain('删除委员会？');
    expect(document.body.textContent).toContain('此操作会永久删除该委员会、其全部记录及上传的文件。');
    expect(document.body.textContent).not.toContain('委员会模板和国家模板不会被删除');

    act(() => login!.cancelCommitteeDeletion());
    await renderLogin(true);
    expect(container.querySelector('button[aria-label="删除委员会“Security Council”"]')).toBeTruthy();
  });
});
