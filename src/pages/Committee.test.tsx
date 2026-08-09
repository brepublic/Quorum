import {describe, expect, it, vi} from 'vitest';

const firebaseMocks = vi.hoisted(() => {
  const committeeRef = {
    on: vi.fn(),
    off: vi.fn()
  };
  const committeesRef = {
    child: vi.fn(() => committeeRef)
  };

  return {committeeRef, committeesRef};
});

vi.mock('firebase/compat/app', () => ({
  default: {
    database: () => ({
      ref: () => firebaseMocks.committeesRef
    }),
    auth: () => ({
      onAuthStateChanged: vi.fn(() => vi.fn())
    })
  }
}));

import Committee from './Committee';

describe('Committee deletion redirect', () => {
  it('replaces the current committee route with the homepage when its record disappears', () => {
    const replace = vi.fn();
    const component = new Committee({
      match: {params: {committeeID: 'deleted-committee'}},
      history: {replace},
      location: {pathname: '/committees/deleted-committee'},
      staticContext: undefined
    } as any);

    component.firebaseCallback({val: () => null} as any);

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('keeps the committee route when the record still exists', () => {
    const replace = vi.fn();
    const component = new Committee({
      match: {params: {committeeID: 'active-committee'}},
      history: {replace},
      location: {pathname: '/committees/active-committee'},
      staticContext: undefined
    } as any);
    component.setState = vi.fn();
    const committee = {name: 'Active committee'};

    component.firebaseCallback({val: () => committee} as any);

    expect(component.setState).toHaveBeenCalledWith({committee});
    expect(replace).not.toHaveBeenCalled();
  });
});
