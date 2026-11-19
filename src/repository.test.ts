import { describe, expect, it } from 'vitest';
import { workspaces } from './data';
import { makeAttempt } from './domain';
import { browserRepository, STORAGE_KEY } from './repository';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

describe('persistent audit repository', () => {
  it('preserves attempts across repository instances and updates without duplicating', async () => {
    const storage = memoryStorage();
    const first = browserRepository(storage);
    const record = makeAttempt(workspaces[0], workspaces[0].flows[0], crypto.randomUUID(), '_DFG2');
    await first.save(record);
    const second = browserRepository(storage);
    expect(await second.list()).toEqual([record]);
    const complete = { ...record, status: 'Completed' as const, targetId: 'demo-target', completedAt: new Date().toISOString() };
    await second.save(complete);
    expect(await first.list()).toEqual([complete]);
    const another = makeAttempt(workspaces[1], workspaces[1].flows[0], crypto.randomUUID(), '_DFG2');
    await first.save(another);
    expect(await second.list()).toHaveLength(2);
  });

  it('does not silently reset corrupted history', async () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, '{bad json');
    const repo = browserRepository(storage);
    await expect(repo.list()).rejects.toThrow();
    const record = makeAttempt(workspaces[0], workspaces[0].flows[0], crypto.randomUUID(), '_DFG2');
    await expect(repo.save(record)).rejects.toThrow();
    expect(storage.getItem(STORAGE_KEY)).toBe('{bad json');
  });

  it('surfaces storage write failures instead of claiming the migration is audited', async () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new Error('Quota exceeded'); };
    const repo = browserRepository(storage);
    const record = makeAttempt(workspaces[0], workspaces[0].flows[0], crypto.randomUUID(), '_DFG2');
    await expect(repo.save(record)).rejects.toThrow('Quota exceeded');
    expect(await repo.list()).toEqual([]);
  });
});
