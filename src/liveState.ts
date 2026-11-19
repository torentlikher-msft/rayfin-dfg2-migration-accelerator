import { z } from 'zod';
import { executionRequestSchema, readinessPageSchema, savedUpgradeSchema, type LiveRunRecord, type Readiness } from '../rayfin/functions/src/contracts';

export const activeStatuses = new Set(['Preparing', 'Submitting', 'Running', 'Verifying', 'Needs reconciliation']);
export const flowKey = (workspaceId: string, id: string) => `${workspaceId}:${id}`;

export function assessmentState(records: LiveRunRecord[]) {
  const latest = new Map<string, { run: LiveRunRecord; items: Map<string, Readiness> }>();
  for (const run of [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))) {
    if (run.action !== 'assess' || run.status !== 'Completed' || latest.has(run.workspaceId)) continue;
    const result = readinessPageSchema.parse(JSON.parse(run.resultJson));
    latest.set(run.workspaceId, { run, items: new Map(result.value.map(item => [item.id, item])) });
  }
  return latest;
}

export function upgradeOutcome(run: LiveRunRecord) {
  if (run.action !== 'upgrade' || !run.resultJson) return null;
  return savedUpgradeSchema.parse(JSON.parse(run.resultJson));
}

export function verifiedConversions(records: LiveRunRecord[]) {
  return new Set(records.flatMap(run => upgradeOutcome(run)?.verifiedGen2Ids.map(id => flowKey(run.workspaceId, id)) ?? []));
}

export function historyDataflows(run: LiveRunRecord, records: LiveRunRecord[]) {
  if (run.action === 'assess') return readinessPageSchema.parse(JSON.parse(run.resultJson || '{"value":[]}')).value.map(item => ({ id: item.id, name: item.displayName }));
  const ids = z.array(z.string().uuid()).parse(JSON.parse(run.targetsJson));
  const outcome = upgradeOutcome(run);
  const names = new Map(Object.entries(outcome?.targetNames ?? {}));
  for (const item of outcome?.apiResult?.migrations ?? []) if (!names.has(item.dataflowId)) names.set(item.dataflowId, item.dataflowName);
  for (const item of outcome?.reconciliation?.items ?? []) if (!names.has(item.id)) names.set(item.id, item.displayName);
  const request = executionRequestSchema.parse(JSON.parse(run.requestJson));
  const assessment = request.action === 'upgrade' ? records.find(item => item.id === request.assessmentId && item.workspaceId === run.workspaceId && item.action === 'assess' && item.status === 'Completed') : null;
  if (assessment) for (const item of readinessPageSchema.parse(JSON.parse(assessment.resultJson)).value) if (!names.has(item.id)) names.set(item.id, item.displayName);
  return ids.map(id => ({ id, name: names.get(id) ?? `Name unavailable (${id})` }));
}
