import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaces } from './data';
import { makeAttempt } from './domain';
import { createRepository } from './repository';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('published Rayfin SDK transport integration', () => {
  it('uses the real SDK for paginated audit queries, create and update', async () => {
    vi.stubEnv('VITE_DATA_MODE', 'rayfin');
    vi.stubEnv('VITE_RAYFIN_API_URL', 'http://127.0.0.1:5168');
    vi.stubEnv('VITE_RAYFIN_PUBLISHABLE_KEY', 'pk-test-only');
    const first = makeAttempt(workspaces[0], workspaces[0].flows[0], crypto.randomUUID(), '_DFG2');
    const second = makeAttempt(workspaces[1], workspaces[1].flows[0], crypto.randomUUID(), '_DFG2');
    const queries: string[] = [];
    let readPage = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toContain('/graphql');
      const body = await request.json() as { query: string };
      queries.push(body.query);
      const root = body.query.match(/\{\s*(\w+)\s*\(/)?.[1];
      if (!root) throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      const isMutation = body.query.startsWith('mutation');
      const result = isMutation ? first : {
        items: readPage++ === 0 ? [first] : [second],
        hasNextPage: readPage === 1,
        endCursor: readPage === 1 ? 'cursor-page-two' : null,
      };
      return new Response(JSON.stringify({ data: { [root]: result } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const repo = await createRepository();
    expect(await repo.list()).toEqual([first, second]);
    expect(queries[1]).toContain('cursor-page-two');
    await repo.save({ ...first, status: 'Completed', completedAt: new Date().toISOString() });
    const third = makeAttempt(workspaces[0], workspaces[0].flows[1], crypto.randomUUID(), '_DFG2');
    await repo.save(third);
    expect(queries[2]).toContain('updateMigrationAttempt');
    expect(queries[3]).toContain('createMigrationAttempt');
  });

  it('rejects unknown modes rather than silently using demo storage', async () => {
    vi.stubEnv('VITE_DATA_MODE', 'invalid-mode');
    await expect(createRepository()).rejects.toThrow('Unknown data mode');
  });
});
