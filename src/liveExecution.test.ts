import { describe, expect, it, vi } from 'vitest';
import { executeRequest, MicrosoftApiError, microsoftApi, readReadiness, trustedMicrosoftUrl, type ApiResponse, type MicrosoftApi, type RunStore } from '../rayfin/functions/src/executionEngine';
import { apiAllowsUpgrade, type ExecutionRequest, type LiveRunRecord, type Readiness, type UpgradeResult } from '../rayfin/functions/src/contracts';
import { activeStatuses, assessmentState, historyDataflows, upgradeOutcome, verifiedConversions } from './liveState';

const ws = '00000000-0000-4000-8000-000000000001';
const flow = '00000000-0000-4000-8000-000000000002';
const flow2 = '00000000-0000-4000-8000-000000000003';
const assessmentId = '00000000-0000-4000-8000-000000000004';
const requestId = '00000000-0000-4000-8000-000000000005';
const operation = 'https://wabi-west-us3-a-primary-redirect.analysis.windows.net/v1/operations/00000000-0000-4000-8000-000000000006?region=west';
const ready: Readiness = { id: flow, displayName: 'Orders', status: 'ReadyToMigrate' };
const response = (body: unknown, status = 200, location: string | null = null): ApiResponse => ({ body, status, location, retryAfter: null });
const upgrade = { action: 'upgrade', requestId, workspaceId: ws, ids: [flow], assessmentId, acknowledgeInPlace: true, acknowledgeAttention: false } satisfies ExecutionRequest;
const outcome = (mixed = false): UpgradeResult => ({ migrations: [
  { dataflowId: flow, dataflowName: 'Orders', workspaceId: ws, workspaceName: 'Finance', migrationStatus: 'Succeeded', requiredActions: [{ code: 'Refresh', message: 'Configure and refresh', status: 'NeedsAttention' }] },
  ...(mixed ? [{ dataflowId: flow2, dataflowName: 'Customers', workspaceId: ws, workspaceName: 'Finance', migrationStatus: 'Failed', migrationError: { errorCode: 'Forbidden', message: 'Not an owner', isRetriable: false } }] : []),
], summary: { totalCount: mixed ? 2 : 1, succeededCount: 1, failedCount: mixed ? 1 : 0 } });

function fixture(readiness: Readiness[] = [ready]) {
  const records = new Map<string, LiveRunRecord>();
  const store: RunStore = {
    async get(id) { return records.has(id) ? structuredClone(records.get(id)!) : null; },
    async insert(run) { if (records.has(run.id)) throw new Error('duplicate'); records.set(run.id, structuredClone(run)); },
    async save(run) { records.set(run.id, structuredClone(run)); },
  };
  const api = vi.fn<MicrosoftApi>(async (method, path) => {
    if (path.includes('gen1UpgradeReadinessResults')) return response({ value: readiness });
    if (method === 'POST') return response(outcome());
    if (path.endsWith(`/dataflows/${flow}`)) return response({ id: flow });
    return response({ id: ws, displayName: 'Finance' });
  });
  return { records, store, api, async assess() {
    return executeRequest({ action: 'assess', requestId: assessmentId, workspaceId: ws }, 'caller', store, api);
  } };
}

async function acceptedFixture(ids = [flow]) {
  const f = fixture(ids.map(id => ({ ...ready, id })));
  await f.assess();
  const api = vi.fn<MicrosoftApi>(async (method, path, body) => method === 'POST' ? response(null, 202, operation) : f.api(method, path, body));
  const run = await executeRequest({ ...upgrade, ids }, 'caller', f.store, api);
  expect(run.status).toBe('Running');
  api.mockClear();
  return { ...f, api, run };
}

describe('authoritative Microsoft assessment and upgrade engine', () => {
  it('preserves Microsoft future verdicts and reasons without a custom readiness heuristic', async () => {
    const item = { ...ready, status: 'NewMicrosoftStatus', newProperty: 3, reasons: [{ code: 'X', message: 'Exact reason', status: 'Future' }] };
    const f = fixture([item]);
    const run = await f.assess();
    expect(JSON.parse(run.resultJson)).toEqual({ value: [item] });
    expect(apiAllowsUpgrade(item)).toBe(false);
    expect(f.api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it.each(['Unknown', 'UpgradeUnavailable', 'Ready', 'Not assessed', 'Future'])('never submits the unsupported verdict %s', async status => {
    const f = fixture([{ ...ready, status }]); await f.assess();
    const run = await executeRequest(upgrade, 'caller', f.store, f.api);
    expect(run.status).toBe('Failed');
    expect(f.api.mock.calls.some(([method]) => method === 'POST')).toBe(false);
  });

  it('rejects readiness changes and unacknowledged API follow-ups before POST', async () => {
    const f = fixture(); await f.assess();
    const changed = vi.fn<MicrosoftApi>(async (method, path, body) => path.includes('ReadinessResults')
      ? response({ value: [{ ...ready, status: 'NeedsAttention', reasons: [{ code: 'Changed', message: 'Review again', status: 'NeedsAttention' }] }] })
      : f.api(method, path, body));
    const run = await executeRequest(upgrade, 'caller', f.store, changed);
    expect(run.error).toContain('changed');
    expect(changed.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    const g = fixture([{ ...ready, status: 'NeedsAttention' }]); await g.assess();
    expect((await executeRequest(upgrade, 'caller', g.store, g.api)).error).toContain('acknowledge');
  });

  it('persists intent before POST, verifies the same Gen2 ID, and deduplicates replayed requests', async () => {
    const f = fixture(); await f.assess();
    const api: MicrosoftApi = async (method, path, body) => {
      if (method === 'POST') {
        expect(f.records.get(requestId)?.status).toBe('Submitting');
        expect(historyDataflows(f.records.get(requestId)!, [])).toEqual([{ id: flow, name: 'Orders' }]);
      }
      return f.api(method, path, body);
    };
    const run = await executeRequest(upgrade, 'caller', f.store, api);
    expect(run.status).toBe('Completed');
    expect(JSON.parse(run.resultJson).verifiedGen2Ids).toEqual([flow]);
    await executeRequest(upgrade, 'caller', f.store, api);
    expect(f.api.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    await expect(executeRequest({ ...upgrade, ids: [flow2] }, 'caller', f.store, api)).rejects.toThrow('different parameters');
  });

  it('resumes regional LROs using GET only and preserves operation query parameters', async () => {
    const f = fixture(); await f.assess();
    const api = vi.fn<MicrosoftApi>(async (method, path, body) => {
      if (method === 'POST') return response(null, 202, operation);
      if (path.includes('/result?')) return response(outcome());
      if (path.startsWith(operation)) return response({ status: 'Succeeded' });
      return f.api(method, path, body);
    });
    expect((await executeRequest(upgrade, 'caller', f.store, api)).status).toBe('Running');
    api.mockClear();
    const run = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, api);
    expect(run.status).toBe('Completed');
    expect(api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    expect(api.mock.calls.some(([, path]) => path.endsWith('/result?region=west'))).toBe(true);
  });

  it.each(['state', 'result'])('reconciles an unavailable operation %s using exact-ID Gen2 evidence without inventing API results', async missing => {
    const f = await acceptedFixture();
    f.api.mockImplementation(async (_method, path) => {
      if (path.includes('/operations/')) {
        if (missing === 'result' && !path.includes('/result?')) return response({ status: 'Succeeded' });
        throw new MicrosoftApiError(404, 'Microsoft operation HTTP 404');
      }
      expect(path).toBe(`workspaces/${ws}/dataflows/${flow}`);
      return response({ id: flow, displayName: 'Orders', type: 'Dataflow' });
    });
    const run = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, f.api);
    expect(run.status).toBe('Reconciled');
    expect(activeStatuses.has(run.status)).toBe(false);
    expect(run.completedAt).not.toBe('');
    expect(run.error).toBe('');
    expect(upgradeOutcome(run)?.apiResult).toBeUndefined();
    expect(upgradeOutcome(run)?.reconciliation).toMatchObject({ method: 'SameIdGen2Readback', operationUrl: operation,
      operationError: 'Microsoft operation HTTP 404', items: [{ id: flow, displayName: 'Orders', type: 'Dataflow' }], unverifiedIds: [] });
    expect([...verifiedConversions([run])]).toEqual([`${ws}:${flow}`]);
    expect(f.api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    f.api.mockClear();
    expect((await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, f.api)).status).toBe('Reconciled');
    expect(f.api).not.toHaveBeenCalled();
  });

  it.each(['missing', 'Gen1 API error', 'wrong ID', 'wrong type'])('does not reconcile a %s Gen2 readback', async scenario => {
    const f = await acceptedFixture();
    f.api.mockImplementation(async (_method, path) => {
      if (path.includes('/operations/')) throw new MicrosoftApiError(404, 'Operation unavailable');
      if (scenario === 'missing' || scenario === 'Gen1 API error') throw new MicrosoftApiError(scenario === 'missing' ? 404 : 500, 'Not confirmed as Gen2');
      return response({ id: scenario === 'wrong ID' ? flow2 : flow, displayName: 'Orders', type: scenario === 'wrong type' ? 'Notebook' : 'Dataflow' });
    });
    const run = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, f.api);
    expect(run.status).toBe('Needs reconciliation');
    expect(run.error).toContain('Only 0/1 selected IDs were verified as Gen2');
    expect(run.completedAt).toBe('');
    expect(upgradeOutcome(run)?.apiResult).toBeUndefined();
    expect(upgradeOutcome(run)?.reconciliation?.unverifiedIds).toEqual([flow]);
    expect(verifiedConversions([run]).size).toBe(0);
    expect(f.api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('saves partial readback evidence, keeps the workspace locked, and resumes only unverified selected IDs', async () => {
    const f = await acceptedFixture([flow, flow2]);
    let remainingReady = false;
    f.api.mockImplementation(async (_method, path) => {
      if (path.includes('/operations/')) throw new MicrosoftApiError(404, 'Operation unavailable');
      const id = path.endsWith(flow2) ? flow2 : flow;
      if (id === flow2 && !remainingReady) throw new MicrosoftApiError(500, 'Still Gen1 or otherwise unavailable');
      return response({ id, displayName: 'Orders', type: 'Dataflow' });
    });
    const partial = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, f.api);
    expect(partial.status).toBe('Needs reconciliation');
    expect(activeStatuses.has(partial.status)).toBe(true);
    expect([...verifiedConversions([partial])]).toEqual([`${ws}:${flow}`]);
    expect(upgradeOutcome(partial)?.reconciliation?.unverifiedIds).toEqual([flow2]);
    remainingReady = true;
    f.api.mockClear();
    const complete = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, f.api);
    expect(complete.status).toBe('Reconciled');
    expect(f.api.mock.calls).toEqual([['GET', operation], ['GET', `workspaces/${ws}/dataflows/${flow2}`]]);
    expect(verifiedConversions([complete]).size).toBe(2);
  });

  it.each([401, 403, 500])('does not substitute readback reconciliation for operation HTTP %s', async status => {
    const f = await acceptedFixture();
    f.api.mockRejectedValue(new MicrosoftApiError(status, 'Operation query failed'));
    const run = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, f.api);
    expect(run.status).toBe('Needs reconciliation');
    expect(upgradeOutcome(run)?.reconciliation).toBeUndefined();
    expect(f.api.mock.calls).toEqual([['GET', operation]]);
  });

  it('saves retry timing and pauses unknown operation states instead of spinning indefinitely', async () => {
    const f = await acceptedFixture();
    f.api.mockResolvedValue({ ...response({ status: 'Running', percentComplete: 50 }), retryAfter: '20' });
    const before = Date.now();
    const run = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, f.api);
    expect(run.status).toBe('Running');
    expect(Date.parse(upgradeOutcome(run)!.tracking!.nextPollAt)).toBeGreaterThanOrEqual(before + 20_000);
    expect(upgradeOutcome(run)?.tracking?.operationState).toEqual({ status: 'Running', percentComplete: 50 });
    f.api.mockResolvedValue(response({ status: 'FutureStatus' }));
    const unknown = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, f.api);
    expect(unknown.status).toBe('Needs reconciliation');
    expect(unknown.error).toContain('unknown operation status: FutureStatus');
    expect(upgradeOutcome(unknown)?.tracking?.operationState?.status).toBe('FutureStatus');
    expect(f.api.mock.calls.every(([, path]) => path === operation)).toBe(true);
  });

  it('retains per-item partial failures and required actions, without calling success before readback', async () => {
    const f = fixture([ready, { ...ready, id: flow2 }]); await f.assess();
    let readback = false;
    const api: MicrosoftApi = async (method, path, body) => {
      if (method === 'POST') return response(outcome(true));
      if (path.endsWith(`/dataflows/${flow}`) && !readback) throw new MicrosoftApiError(404, 'Not propagated yet');
      return f.api(method, path, body);
    };
    expect((await executeRequest({ ...upgrade, ids: [flow, flow2] }, 'caller', f.store, api)).status).toBe('Verifying');
    readback = true;
    const run = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, api);
    expect(run.status).toBe('Partial');
    expect(JSON.parse(run.resultJson).apiResult).toEqual(outcome(true));
    expect([...verifiedConversions([run])]).toEqual([`${ws}:${flow}`]);
  });

  it('never retries an uncertain POST, including replay after the connection failed', async () => {
    const f = fixture(); await f.assess();
    const api = vi.fn<MicrosoftApi>(async (method, path, body) => {
      if (method === 'POST') throw new MicrosoftApiError(0, 'Submission outcome unknown', true);
      return f.api(method, path, body);
    });
    const run = await executeRequest(upgrade, 'caller', f.store, api);
    expect(run.status).toBe('Needs reconciliation');
    await executeRequest(upgrade, 'caller', f.store, api);
    expect(api.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('retains unselected skipped workspace rows without treating them as requested migration failures', async () => {
    const f = fixture(); await f.assess();
    const result = outcome();
    const skipped = { ...result.migrations[0], dataflowId: flow2, migrationStatus: 'Skipped',
      migrationError: { errorCode: 'NotSelectedForUpgrade', message: 'The dataflow was not selected for upgrade.', isRetriable: false } };
    result.migrations.push(skipped);
    const api = vi.fn<MicrosoftApi>(async (method, path, body) => method === 'POST' ? response(result) : f.api(method, path, body));
    const run = await executeRequest(upgrade, 'caller', f.store, api);
    expect(run.status).toBe('Completed');
    expect(JSON.parse(run.resultJson)).toEqual({ apiResult: result, verifiedGen2Ids: [flow], targetNames: { [flow]: 'Orders' } });
    expect(historyDataflows(run, [])).toEqual([{ id: flow, name: 'Orders' }]);
    expect(api.mock.calls.some(([, path]) => path.endsWith(`/dataflows/${flow2}`))).toBe(false);

    f.records.set(requestId, { ...run, status: 'Needs reconciliation', completedAt: '',
      resultJson: JSON.stringify({ apiResult: result, verifiedGen2Ids: [] }), error: 'Previous verifier rejected skipped rows.' });
    api.mockClear();
    const recovered = await executeRequest({ action: 'poll', requestId, workspaceId: ws }, 'caller', f.store, api);
    expect(recovered.status).toBe('Completed');
    expect(recovered.error).toBe('');
    expect(recovered.completedAt).not.toBe('');
    expect(api.mock.calls).toEqual([['GET', `workspaces/${ws}/dataflows/${flow}`]]);
    expect(JSON.parse(recovered.resultJson).apiResult).toEqual(result);
  });

  it.each([
    ['unrequested success', 'Succeeded', 'NotSelectedForUpgrade'],
    ['unexplained skip', 'Skipped', 'DifferentReason'],
    ['unknown extra outcome', 'FutureStatus', 'NotSelectedForUpgrade'],
  ])('does not silently ignore an %s', async (_label, status, errorCode) => {
    const f = fixture(); await f.assess();
    const result = outcome();
    result.migrations.push({ ...result.migrations[0], dataflowId: flow2, migrationStatus: status,
      migrationError: { errorCode, message: 'Unexpected unrequested row', isRetriable: false } });
    const api: MicrosoftApi = async (method, path, body) => method === 'POST' ? response(result) : f.api(method, path, body);
    const run = await executeRequest(upgrade, 'caller', f.store, api);
    expect(run.status).toBe('Needs reconciliation');
    expect(f.api.mock.calls.some(([, path]) => path.endsWith(`/dataflows/${flow}`))).toBe(false);
  });

  it('rejects foreign assessments, unknown outcomes, and mismatched Gen2 IDs', async () => {
    const f = fixture(); await f.assess(); f.records.get(assessmentId)!.ownerId = 'another-user';
    expect((await executeRequest(upgrade, 'caller', f.store, f.api)).status).toBe('Failed');
    expect(f.api.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    const g = fixture(); await g.assess();
    const api: MicrosoftApi = async (method, path, body) => method === 'POST'
      ? response({ ...outcome(), migrations: [] }) : g.api(method, path, body);
    expect((await executeRequest(upgrade, 'caller', g.store, api)).status).toBe('Needs reconciliation');
    const h = fixture(); await h.assess();
    const wrongId: MicrosoftApi = async (method, path, body) => path.endsWith(`/dataflows/${flow}`)
      ? response({ id: flow2 }) : h.api(method, path, body);
    expect((await executeRequest(upgrade, 'caller', h.store, wrongId)).status).toBe('Verifying');
  });

  it('does not resurrect an older ready verdict when the newest workspace assessment omits an ID', async () => {
    const f = fixture(); const old = await f.assess();
    const recent = { ...old, id: requestId, startedAt: '2099-01-01T00:00:00.000Z', resultJson: '{"value":[]}' };
    expect(assessmentState([old, recent]).get(ws)?.items.has(flow)).toBe(false);
  });

  it('resolves pending and legacy history names from their original evidence without guessing names from other assessments', async () => {
    const f = await acceptedFixture();
    expect(historyDataflows(f.run, [])).toEqual([{ id: flow, name: 'Orders' }]);
    const legacy = { ...f.run, resultJson: '' };
    expect(historyDataflows(legacy, [...f.records.values()])).toEqual([{ id: flow, name: 'Orders' }]);
    expect(historyDataflows(legacy, [])).toEqual([{ id: flow, name: `Name unavailable (${flow})` }]);
    const reconciled = { ...f.run, resultJson: JSON.stringify({ verifiedGen2Ids: [flow], reconciliation: {
      method: 'SameIdGen2Readback', operationUrl: operation, operationError: '404', checkedAt: new Date().toISOString(),
      items: [{ id: flow, displayName: 'Readback Orders', type: 'Dataflow' }], unverifiedIds: [],
    } }) };
    expect(historyDataflows(reconciled, [])).toEqual([{ id: flow, name: 'Readback Orders' }]);
  });

  it('rejects cross-origin pagination, repeated pages, and credential-forwarding URLs', async () => {
    const api: MicrosoftApi = async () => response({ value: [], continuationUri: 'https://attacker.example/v1/page' });
    await expect(readReadiness(api, ws)).rejects.toThrow('untrusted');
    expect(() => trustedMicrosoftUrl('https://api.fabric.microsoft.com.attacker.example/v1/')).toThrow('untrusted');
    const repeat: MicrosoftApi = async () => response({ value: [], continuationToken: 'repeat' });
    await expect(readReadiness(repeat, ws)).rejects.toThrow('repeated');
  });

  it('passes the user token and telemetry to Microsoft and does not retry POST on 503', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"message":"Unavailable"}', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(microsoftApi('delegated-user')('POST', `workspaces/${ws}/dataflows/gen1Upgrade`, {})).rejects.toMatchObject({ ambiguous: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer delegated-user', 'x-ms-fabric-skill': 'dataflows-cli' });
    } finally { vi.unstubAllGlobals(); }
  });
});
