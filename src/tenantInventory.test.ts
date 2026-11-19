import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverInventory, trustedInventoryUrl } from './tenantInventory';
import { isSelectable, makeAttempt } from './domain';
import type { TenantSession } from './tenantAuth';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = { username: 'operator@example.test', name: 'Test operator', tenantId: id(1), homeAccountId: 'test-account' };
function session(pipelines = true): TenantSession {
  return { account, config: { tenantId: id(1), clientId: id(2), includePipelines: pipelines },
    getToken: vi.fn().mockResolvedValue('test-delegated-token'), disconnect: vi.fn() };
}
const json = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

function fakeApi(handler: (url: URL) => Response | Promise<Response>) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.headers.get('Authorization')).toBe('Bearer test-delegated-token');
    expect(request.method).toBe('GET');
    const url = new URL(request.url);
    requests.push(url);
    return handler(url);
  }));
  return requests;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('delegated real-tenant inventory', () => {
  it('joins real pipeline membership, excludes confirmed Gen2, and never fabricates readiness', async () => {
    fakeApi(url => {
      if (url.pathname.endsWith('/groups')) return json({ value: [{ id: id(10), name: 'Actual workspace', isOnDedicatedCapacity: true }] });
      if (url.pathname.endsWith('/pipelines')) return json({ value: [{ id: id(11), displayName: 'Actual pipeline' }] });
      if (url.pathname.endsWith('/stages')) return json({ value: [
        { order: 0 }, { order: 1 }, { order: 2, workspaceId: id(10) },
      ] });
      return json({ value: [
        { objectId: id(20), name: 'Actual Gen1', generation: 1, configuredBy: account.username },
        { objectId: id(21), name: 'Already Gen2', generation: 2 },
        { objectId: id(22), name: 'Generation not returned' },
      ] });
    });
    const result = await discoverInventory(session(), new AbortController().signal);
    expect(result.accessibleWorkspaces).toBe(1);
    expect(result.skippedGen2).toBe(1);
    expect(result.workspaces[0]).toMatchObject({ name: 'Actual workspace', pipeline: 'Actual pipeline', stage: 'Production' });
    expect(result.workspaces[0].flows).toHaveLength(2);
    const flow = result.workspaces[0].flows[0];
    expect(flow).toMatchObject({ origin: 'live', generation: 1, compatibility: 'Not assessed', entities: null, modified: null, configuredBy: account.username });
    expect(result.workspaces[0].flows[1].generation).toBeNull();
    expect(isSelectable(flow, new Set(), new Set())).toBe(false);
    expect(() => makeAttempt(result.workspaces[0], flow, crypto.randomUUID(), '_DFG2')).toThrow('Live inventory');
  });

  it('paginates accessible workspaces and dataflows without dropping items', async () => {
    const requests = fakeApi(url => {
      if (url.pathname.endsWith('/groups')) {
        const skip = Number(url.searchParams.get('$skip'));
        return json({ value: skip === 0
          ? Array.from({ length: 100 }, (_, i) => ({ id: id(100 + i), name: `Workspace ${i}` }))
          : [{ id: id(200), name: 'Last workspace' }] });
      }
      if (url.pathname.includes(id(200))) {
        return json({ value: [{ objectId: url.searchParams.has('page') ? id(301) : id(300), name: 'Real dataflow', generation: '1' }],
          ...(url.searchParams.has('page') ? {} : { '@odata.nextLink': `https://api.powerbi.com/v1.0/myorg/groups/${id(200)}/dataflows?page=2` }),
        });
      }
      return json({ value: [] });
    });
    const result = await discoverInventory(session(false), new AbortController().signal);
    expect(result.accessibleWorkspaces).toBe(101);
    expect(result.workspaces[0].flows).toHaveLength(2);
    expect(requests.filter(u => u.pathname.endsWith('/groups'))[1].searchParams.get('$skip')).toBe('100');
    expect(requests.some(u => u.pathname.endsWith('/pipelines'))).toBe(false);
    expect(result.workspaces[0].stage).toBe('Unknown');
  });

  it('surfaces partial workspace and pipeline permission failures without claiming Unassigned', async () => {
    fakeApi(url => {
      if (url.pathname.endsWith('/groups')) return json({ value: [{ id: id(10), name: 'Readable' }, { id: id(11), name: 'Denied' }] });
      if (url.pathname.endsWith('/pipelines') || url.pathname.includes(id(11))) return json({}, 403);
      return json({ value: [{ objectId: id(20), name: 'Visible flow', generation: 1 }] });
    });
    const result = await discoverInventory(session(), new AbortController().signal);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].stage).toBe('Unknown');
    expect(result.warnings.join(' ')).toContain('Pipeline discovery unavailable');
    expect(result.warnings.join(' ')).toContain('Denied: dataflows could not be read');
  });

  it('does not downgrade rejected identity tokens to partial success', async () => {
    fakeApi(url => url.pathname.endsWith('/groups')
      ? json({ value: [{ id: id(10), name: 'Workspace' }] }) : json({}, 401));
    await expect(discoverInventory(session(false), new AbortController().signal)).rejects.toThrow('Reconnect');
  });

  it('rejects hostile continuation URLs before sending a bearer token', async () => {
    const requests = fakeApi(() => json({ value: [], '@odata.nextLink': 'https://other.example.test/steal' }));
    await expect(discoverInventory(session(false), new AbortController().signal)).rejects.toThrow('untrusted pagination URL');
    expect(requests).toHaveLength(1);
    expect(() => trustedInventoryUrl('https://api.powerbi.com/v1.0/elsewhere')).toThrow('untrusted');
  });

  it('rejects repeated workspace pages instead of endlessly reading duplicates', async () => {
    const requests = fakeApi(() => json({ value: Array.from({ length: 100 }, (_, i) => ({ id: id(100 + i), name: `Workspace ${i}` })) }));
    await expect(discoverInventory(session(false), new AbortController().signal)).rejects.toThrow('duplicate record IDs');
    expect(requests).toHaveLength(2);
  });

  it('honors Retry-After for throttled read requests', async () => {
    vi.useFakeTimers();
    let calls = 0;
    fakeApi(() => calls++ === 0 ? json({}, 429, { 'Retry-After': '2' }) : json({ value: [] }));
    const result = discoverInventory(session(false), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).workspaces).toEqual([]);
    expect(calls).toBe(2);
  });

  it('stops discovery immediately when the user disconnects', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(discoverInventory(session(false), controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
