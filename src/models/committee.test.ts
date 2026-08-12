import {beforeEach, describe, expect, it, vi} from 'vitest';

const firebaseMocks = vi.hoisted(() => {
  const databaseRemove = vi.fn();
  const databaseCommitteeRef = {remove: databaseRemove};
  const databaseRootRef = {
    child: vi.fn(() => databaseCommitteeRef)
  };
  const databaseRef = vi.fn(() => databaseRootRef);

  const topLevelDelete = vi.fn();
  const nestedDelete = vi.fn();
  const nestedStorageRef = {
    listAll: vi.fn(async () => ({
      items: [{delete: nestedDelete}],
      prefixes: []
    }))
  };
  const committeeStorageRef = {
    listAll: vi.fn(async () => ({
      items: [{delete: topLevelDelete}],
      prefixes: [nestedStorageRef]
    }))
  };
  const committeesStorageRef = {
    child: vi.fn(() => committeeStorageRef)
  };
  const storageRootRef = {
    child: vi.fn(() => committeesStorageRef)
  };

  return {
    databaseCommitteeRef,
    databaseRef,
    databaseRemove,
    nestedDelete,
    nestedStorageRef,
    topLevelDelete,
    committeeStorageRef,
    committeesStorageRef,
    storageRootRef
  };
});

vi.mock('firebase/compat/app', () => ({
  default: {
    database: () => ({ref: firebaseMocks.databaseRef}),
    storage: () => ({ref: () => firebaseMocks.storageRootRef})
  }
}));

import {deleteCommittee} from './committee';

describe('deleteCommittee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firebaseMocks.topLevelDelete.mockResolvedValue(undefined);
    firebaseMocks.nestedDelete.mockResolvedValue(undefined);
    firebaseMocks.databaseRemove.mockResolvedValue(undefined);
  });

  it('recursively deletes committee files before removing the committee record', async () => {
    await deleteCommittee('committee-1');

    expect(firebaseMocks.storageRootRef.child).toHaveBeenCalledWith('committees');
    expect(firebaseMocks.committeesStorageRef.child).toHaveBeenCalledWith('committee-1');
    expect(firebaseMocks.committeeStorageRef.listAll).toHaveBeenCalledOnce();
    expect(firebaseMocks.nestedStorageRef.listAll).toHaveBeenCalledOnce();
    expect(firebaseMocks.topLevelDelete).toHaveBeenCalledOnce();
    expect(firebaseMocks.nestedDelete).toHaveBeenCalledOnce();
    expect(firebaseMocks.databaseRef).toHaveBeenCalledWith('committees');
    expect(firebaseMocks.databaseCommitteeRef.remove).toHaveBeenCalledOnce();

    const finalFileDelete = Math.max(
      firebaseMocks.topLevelDelete.mock.invocationCallOrder[0],
      firebaseMocks.nestedDelete.mock.invocationCallOrder[0]
    );
    expect(firebaseMocks.databaseRemove.mock.invocationCallOrder[0]).toBeGreaterThan(finalFileDelete);
  });

  it('keeps the database record when an uploaded file cannot be deleted', async () => {
    firebaseMocks.topLevelDelete.mockRejectedValueOnce(new Error('storage denied'));

    await expect(deleteCommittee('committee-1')).rejects.toThrow('storage denied');
    expect(firebaseMocks.databaseRemove).not.toHaveBeenCalled();
  });
});
