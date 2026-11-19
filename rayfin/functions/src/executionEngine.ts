import { z } from 'zod';
import {
  apiAllowsUpgrade, executionRequestSchema, gen2ReadbackSchema, readinessPageSchema, readinessSchema, savedUpgradeSchema, upgradeResultSchema,
  type ExecutionRequest, type LiveRunRecord, type Readiness, type UpgradeResult,
} from './contracts.js';

export interface RunStore {
  get(id: string): Promise<LiveRunRecord | null>;
  insert(run: LiveRunRecord): Promise<void>;
  save(run: LiveRunRecord): Promise<void>;
}
export interface ApiResponse { status: number; body: unknown; location: string | null; retryAfter: string | null; }
export type MicrosoftApi = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<ApiResponse>;

export class MicrosoftApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly ambiguous = false) { super(message); }
}

export function trustedMicrosoftUrl(path: string): URL {
  const url = new URL(path, 'https://api.fabric.microsoft.com/v1/');
  const official = url.hostname === 'api.fabric.microsoft.com'
    || url.hostname.endsWith('.analysis.windows.net') || url.hostname.endsWith('.pbidedicated.windows.net');
  if (url.protocol !== 'https:' || !official || url.username || url.password || url.hash || url.port) {
    throw new Error('Microsoft returned an untrusted API URL. No credential was forwarded.');
  }
  if (!url.pathname.startsWith('/v1/')) throw new Error('Unexpected Microsoft API path.');
  return url;
}

export function trustedOperationUrl(path: string): URL {
  const url = trustedMicrosoftUrl(path);
  if (!/^\/v1\/operations\/[0-9a-f-]{36}$/i.test(url.pathname.replace(/\/$/, ''))) {
    throw new Error('Unexpected upgrade operation URL.');
  }
  return url;
}

export function microsoftApi(token: string): MicrosoftApi {
  const deadline = Date.now() + 180_000;
  return async (method, path, body) => {
    const url = trustedMicrosoftUrl(path);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= deadline) throw new MicrosoftApiError(0, 'Invocation time budget reached. Refresh to continue tracking.');
      let response: Response;
      try {
        response = await fetch(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ms-fabric-skill': 'dataflows-cli' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new MicrosoftApiError(0, `${method} ${url.pathname}: connection failed. ${method === 'POST' ? 'Submission may have been accepted; do not resubmit.' : 'Reconnect and refresh to continue tracking.'}`, method === 'POST');
      }
      if (method === 'GET' && [429, 503].includes(response.status) && attempt < 2) {
        const retry = response.headers.get('Retry-After');
        const milliseconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000
          : retry && Number.isFinite(Date.parse(retry)) ? Math.max(0, Date.parse(retry) - Date.now()) : 2000 * (attempt + 1);
        if (milliseconds > 30_000 || Date.now() + milliseconds >= deadline) throw new MicrosoftApiError(response.status, `Microsoft requested a ${Math.ceil(milliseconds / 1000)}s pause. Retry later.`);
        await new Promise(resolve => setTimeout(resolve, milliseconds));
        continue;
      }
      const text = await response.text();
      let result: unknown;
      try { result = text ? JSON.parse(text) : null; }
      catch { throw new MicrosoftApiError(response.status, `Microsoft returned a non-JSON response for ${method} ${url.pathname}.`, method === 'POST'); }
      if (!response.ok) {
        const error = z.object({ errorCode: z.string().optional(), message: z.string().optional(),
          error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional() }).safeParse(result);
        const detail = error.success ? error.data.error?.message || error.data.message || error.data.errorCode || error.data.error?.code : '';
        throw new MicrosoftApiError(response.status, `Microsoft API HTTP ${response.status} for ${method} ${url.pathname}${detail ? `: ${detail}` : ''}`, method === 'POST' && response.status >= 500);
      }
      return { status: response.status, body: result, location: response.headers.get('Location'), retryAfter: response.headers.get('Retry-After') };
    }
    throw new Error('Microsoft API retry budget exhausted.');
  };
}

export async function readReadiness(api: MicrosoftApi, workspaceId: string): Promise<Readiness[]> {
  const base = `workspaces/${workspaceId}/dataflows/gen1UpgradeReadinessResults`;
  let path = base + '?pageSize=30';
  const results: Readiness[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  const deadline = Date.now() + 150_000;
  while (path) {
    if (Date.now() > deadline) throw new Error('Readiness pagination exceeded the invocation budget. No partial assessment was marked complete.');
    const url = trustedMicrosoftUrl(path);
    if (url.pathname !== `/v1/${base}` || seen.has(url.href)) throw new Error('Unexpected or repeated readiness continuation URL.');
    seen.add(url.href);
    const page = readinessPageSchema.parse((await api('GET', url.href)).body);
    for (const result of page.value) {
      if (ids.has(result.id)) throw new Error('Microsoft returned duplicate readiness IDs.');
      ids.add(result.id); results.push(result);
    }
    if (page.continuationUri) path = page.continuationUri;
    else if (page.continuationToken) path = base + '?pageSize=30&continuationToken=' + encodeURIComponent(page.continuationToken);
    else path = '';
  }
  return results;
}

function comparable(readiness: Readiness) {
  return JSON.stringify({ status: readiness.status, reasons: readiness.reasons ?? [] });
}

function saveUpgradeEvidence(run: LiveRunRecord, evidence: z.input<typeof savedUpgradeSchema>) {
  const previous = run.resultJson ? savedUpgradeSchema.parse(JSON.parse(run.resultJson)) : null;
  run.resultJson = JSON.stringify({ ...evidence, targetNames: evidence.targetNames ?? previous?.targetNames });
}

export async function executeRequest(
  input: ExecutionRequest, ownerId: string, store: RunStore, api: MicrosoftApi,
): Promise<LiveRunRecord> {
  const request = executionRequestSchema.parse(input);
  const previous = await store.get(request.requestId);
  if (previous && previous.ownerId !== ownerId) throw new Error('Owned execution record not found.');
  if (request.action === 'poll') {
    if (!previous || previous.workspaceId !== request.workspaceId || previous.action !== 'upgrade') throw new Error('Owned upgrade record not found.');
    return pollRun(previous, store, api);
  }
  if (previous) {
    if (previous.requestJson !== JSON.stringify(request)) throw new Error('Request ID was already used with different parameters.');
    if (previous.status === 'Submitting') throw new Error('Submission outcome is uncertain. Reconcile this request; it will not be resubmitted.');
    return previous;
  }
  const now = new Date().toISOString();
  const run: LiveRunRecord = {
    id: request.requestId, ownerId, action: request.action, workspaceId: request.workspaceId,
    workspaceName: request.workspaceId, status: 'Preparing', startedAt: now, completedAt: '', operationUrl: '',
    targetsJson: JSON.stringify(request.action === 'upgrade' ? request.ids : []), requestJson: JSON.stringify(request), resultJson: '', error: '',
  };
  await store.insert(run);
  let submitting = false;
  try {
    const workspace = z.object({ id: z.string().uuid(), displayName: z.string() }).parse((await api('GET', `workspaces/${request.workspaceId}`)).body);
    if (workspace.id !== request.workspaceId) throw new Error('Unexpected workspace returned by Microsoft.');
    run.workspaceName = workspace.displayName;
    const readiness = await readReadiness(api, request.workspaceId);
    if (request.action === 'assess') {
      run.resultJson = JSON.stringify({ value: readiness });
      run.status = 'Completed'; run.completedAt = new Date().toISOString();
      await store.save(run); return run;
    }
    if (new Set(request.ids).size !== request.ids.length) throw new Error('Duplicate dataflow IDs were selected.');
    const assessment = await store.get(request.assessmentId);
    if (!assessment || assessment.ownerId !== ownerId || assessment.action !== 'assess' || assessment.status !== 'Completed' || assessment.workspaceId !== request.workspaceId) {
      throw new Error('A completed assessment owned by this user is required for this workspace.');
    }
    const reviewed = z.object({ value: z.array(readinessSchema) }).parse(JSON.parse(assessment.resultJson)).value;
    for (const id of request.ids) {
      const current = readiness.find(item => item.id === id);
      const earlier = reviewed.find(item => item.id === id);
      if (!current || !earlier) throw new Error(`Microsoft has not confirmed ${id} as an assessed Gen1 candidate. Reassess before upgrading.`);
      if (!apiAllowsUpgrade(current)) throw new Error(`Microsoft returned ${current.status} for ${current.displayName}. Upgrade not submitted.`);
      if (comparable(current) !== comparable(earlier)) throw new Error('Microsoft readiness changed since your review. Reassess before upgrading.');
      if (current.status === 'NeedsAttention' && !request.acknowledgeAttention) throw new Error('Review and acknowledge the API-required follow-ups.');
    }
    const body = { dataflows: request.ids.map(id => ({ id })) };
    if (Buffer.byteLength(JSON.stringify(body)) > 13_312) throw new Error('Upgrade body exceeds the Microsoft API request limit.');
    run.status = 'Submitting';
    saveUpgradeEvidence(run, { targetNames: Object.fromEntries(readiness.filter(item => request.ids.includes(item.id)).map(item => [item.id, item.displayName])), verifiedGen2Ids: [] });
    await store.save(run);
    submitting = true;
    const response = await api('POST', `workspaces/${request.workspaceId}/dataflows/gen1Upgrade`, body);
    if (response.status === 202) {
      if (!response.location) throw new Error('Upgrade was accepted without a tracking URL. Do not resubmit.');
      run.operationUrl = trustedOperationUrl(response.location).href;
      saveUpgradeEvidence(run, { tracking: { nextPollAt: nextPollAt(response.retryAfter) }, verifiedGen2Ids: [] });
      run.status = 'Running'; await store.save(run); return run;
    }
    if (response.status !== 200) throw new Error('Unexpected upgrade submission status. Do not resubmit.');
    saveUpgradeEvidence(run, { apiResult: upgradeResultSchema.parse(response.body), verifiedGen2Ids: [] });
    run.status = 'Verifying';
    await store.save(run);
    return await verifyResult(run, store, api);
  } catch (error) {
    run.error = error instanceof Error ? error.message : 'Unexpected execution failure.';
    run.status = submitting && (!(error instanceof MicrosoftApiError) || error.ambiguous) ? 'Needs reconciliation' : 'Failed';
    run.completedAt = run.status === 'Failed' ? new Date().toISOString() : '';
    await store.save(run);
    return run;
  }
}

async function pollRun(run: LiveRunRecord, store: RunStore, api: MicrosoftApi): Promise<LiveRunRecord> {
  if (['Completed', 'Partial', 'Failed', 'Reconciled'].includes(run.status)) return run;
  try {
    const saved = run.resultJson ? savedUpgradeSchema.parse(JSON.parse(run.resultJson)) : null;
    if (saved?.apiResult) return await verifyResult(run, store, api);
    if (!run.operationUrl) throw new Error('No operation URL was saved. The submission must be reconciled manually; it cannot be automatically retried.');
    const url = trustedOperationUrl(run.operationUrl);
    let state: { status: string; error?: unknown };
    try {
      const response = await api('GET', url.href);
      state = z.object({ status: z.string(), error: z.unknown().optional() }).passthrough().parse(response.body);
      saveUpgradeEvidence(run, { ...saved, tracking: { nextPollAt: nextPollAt(response.retryAfter), operationState: state }, verifiedGen2Ids: saved?.verifiedGen2Ids ?? [] });
      await store.save(run);
      if (state.status === 'Succeeded') {
        url.pathname = url.pathname.replace(/\/$/, '') + '/result';
        const result = upgradeResultSchema.parse((await api('GET', url.href)).body);
        saveUpgradeEvidence(run, { apiResult: result, verifiedGen2Ids: [] });
      }
    } catch (error) {
      if (error instanceof MicrosoftApiError && error.status === 404) return await reconcileGen2(run, store, api, error.message);
      throw error;
    }
    if (['Failed', 'Cancelled'].includes(state.status)) {
      run.status = 'Failed'; run.completedAt = new Date().toISOString();
      run.error = JSON.stringify(state.error ?? { status: state.status });
    } else if (state.status === 'Succeeded') {
      run.status = 'Verifying'; await store.save(run);
      return await verifyResult(run, store, api);
    } else if (['NotStarted', 'Running'].includes(state.status)) {
      run.status = 'Running'; run.error = '';
    } else throw new Error(`Microsoft returned an unknown operation status: ${state.status}. Review the saved operation state before continuing.`);
  } catch (error) {
    run.error = error instanceof Error ? error.message : 'Could not track the upgrade.';
    run.status = 'Needs reconciliation';
  }
  await store.save(run); return run;
}

function nextPollAt(retryAfter: string | null): string {
  const now = Date.now();
  const requested = retryAfter && /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '');
  return new Date(Math.max(now + 5000, Number.isFinite(requested) && requested < 8.64e15 ? requested : now)).toISOString();
}

async function reconcileGen2(run: LiveRunRecord, store: RunStore, api: MicrosoftApi, operationError: string): Promise<LiveRunRecord> {
  const targets = z.array(z.string().uuid()).min(1).max(50).parse(JSON.parse(run.targetsJson));
  const request = executionRequestSchema.parse(JSON.parse(run.requestJson));
  if (request.action !== 'upgrade' || request.workspaceId !== run.workspaceId || request.requestId !== run.id
    || new Set(targets).size !== targets.length || targets.length !== request.ids.length || targets.some(id => !request.ids.includes(id))) {
    throw new Error('The saved selection does not match the original upgrade request. Manual reconciliation is required.');
  }
  const saved = run.resultJson ? savedUpgradeSchema.parse(JSON.parse(run.resultJson)) : null;
  const items = new Map((saved?.reconciliation?.items ?? []).map(item => [item.id, item]));
  if ([...items.keys()].some(id => !targets.includes(id))) throw new Error('Saved Gen2 evidence includes an unselected ID. Manual reconciliation is required.');
  const errors: string[] = [];
  const deadline = Date.now() + 100_000;
  for (const id of targets) {
    if (items.has(id)) continue;
    if (Date.now() >= deadline) { errors.push('Readback time budget reached; refresh to check the remaining IDs.'); break; }
    try {
      const item = gen2ReadbackSchema.parse((await api('GET', `workspaces/${run.workspaceId}/dataflows/${id}`)).body);
      if (item.id !== id) throw new Error('The Gen2 readback ID did not match the selected source ID.');
      items.set(id, item);
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : 'Gen2 readback could not be verified.'}`);
    }
  }
  const unverifiedIds = targets.filter(id => !items.has(id));
  const checkedAt = new Date().toISOString();
  saveUpgradeEvidence(run, { tracking: saved?.tracking, verifiedGen2Ids: [...items.keys()], reconciliation: {
    method: 'SameIdGen2Readback', operationUrl: run.operationUrl,
    operationError: saved?.reconciliation?.operationError ?? operationError, checkedAt, items: [...items.values()], unverifiedIds,
  } });
  run.status = unverifiedIds.length ? 'Needs reconciliation' : 'Reconciled';
  run.completedAt = unverifiedIds.length ? '' : checkedAt;
  run.error = unverifiedIds.length ? `${operationError} Only ${items.size}/${targets.length} selected IDs were verified as Gen2. ${errors.join(' ')}` : '';
  await store.save(run); return run;
}

async function verifyResult(run: LiveRunRecord, store: RunStore, api: MicrosoftApi): Promise<LiveRunRecord> {
  const stored = z.object({ apiResult: upgradeResultSchema, verifiedGen2Ids: z.array(z.string()) }).parse(JSON.parse(run.resultJson));
  const targets = z.array(z.string().uuid()).parse(JSON.parse(run.targetsJson));
  const result: UpgradeResult = stored.apiResult;
  const targetIds = new Set(targets);
  const returnedIds = result.migrations.map(item => item.dataflowId);
  const selectedMigrations = result.migrations.filter(item => targetIds.has(item.dataflowId));
  if (targetIds.size !== targets.length || selectedMigrations.length !== targets.length
    || new Set(returnedIds).size !== returnedIds.length
    || targets.some(id => !returnedIds.includes(id)) || result.migrations.some(item => item.workspaceId !== run.workspaceId)
    || selectedMigrations.some(item => !['Succeeded', 'Failed'].includes(item.migrationStatus))
    || result.migrations.some(item => !targetIds.has(item.dataflowId)
      && (item.migrationStatus !== 'Skipped' || item.migrationError?.errorCode !== 'NotSelectedForUpgrade'))) {
    throw new Error('Microsoft returned an incomplete or unknown migration outcome. Manual reconciliation is required.');
  }
  const verified = new Set(stored.verifiedGen2Ids);
  const deadline = Date.now() + 100_000;
  run.error = '';
  for (const migration of selectedMigrations) {
    if (migration.migrationStatus !== 'Succeeded' || verified.has(migration.dataflowId)) continue;
    if (Date.now() >= deadline) break;
    try {
      const item = z.object({ id: z.string().uuid() }).parse((await api('GET', `workspaces/${run.workspaceId}/dataflows/${migration.dataflowId}`)).body);
      if (item.id !== migration.dataflowId) throw new Error('The upgraded Gen2 readback ID did not match the source ID.');
      verified.add(item.id);
    } catch (error) {
      run.error = error instanceof Error ? error.message : 'Gen2 readback has not completed.';
      break;
    }
  }
  saveUpgradeEvidence(run, { apiResult: result, verifiedGen2Ids: [...verified] });
  const succeeded = selectedMigrations.filter(item => item.migrationStatus === 'Succeeded').length;
  const failed = selectedMigrations.length - succeeded;
  if (result.summary.totalCount !== targets.length || result.summary.succeededCount !== succeeded || result.summary.failedCount !== failed) {
    throw new Error('Microsoft migration summary did not match its per-dataflow results.');
  }
  run.status = verified.size < succeeded ? 'Verifying' : failed === 0 ? 'Completed' : succeeded === 0 ? 'Failed' : 'Partial';
  if (['Completed', 'Partial', 'Failed'].includes(run.status)) run.completedAt = new Date().toISOString();
  await store.save(run); return run;
}
