import * as React from 'react';
import {act} from 'react';
import {expect, it, vi} from 'vitest';
import { createRoot } from 'react-dom/client';
import App from './App';

vi.mock('./pages/SelfHostedIdentity', () => ({default: () => <main>自主托管身份</main>}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

it('renders without crashing', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<App />));
  expect(container.textContent).toBe('自主托管身份');
  act(() => root.unmount());
});
