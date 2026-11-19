import { z } from 'zod';

export type Stage = string;
export type Compatibility = 'Ready' | 'Needs review' | 'Blocked' | 'Not assessed';
export interface Dataflow {
  id: string;
  name: string;
  source: string;
  entities: number | null;
  compatibility: Compatibility;
  issues: string[];
  modified: string | null;
  origin?: 'live';
  generation?: 1 | 2 | null;
  configuredBy?: string;
  description?: string;
}
export interface Workspace {
  id: string;
  name: string;
  domain: string;
  pipeline: string;
  stage: Stage;
  capacity: string;
  flows: Dataflow[];
}

export const auditSchema = z.object({
  id: z.string().uuid(), batchId: z.string().uuid(), sourceId: z.string(),
  sourceName: z.string(), workspaceId: z.string(), workspaceName: z.string(),
  stage: z.string().min(1),
  status: z.enum(['Running', 'Completed', 'Failed']),
  startedAt: z.string().datetime(), completedAt: z.union([z.literal(''), z.string().datetime()]),
  targetName: z.string(), targetId: z.string(), actor: z.string(), details: z.string(),
  mode: z.literal('Demo'),
});
export type AuditRecord = z.infer<typeof auditSchema>;
export interface Filters { search: string; stage: string; compatibility: string; }

export function generationLabel(flow: Dataflow): string {
  if (flow.origin !== 'live') return 'Dataflow Gen1';
  return flow.generation ? `Dataflow Gen${flow.generation}` : 'Generation unverified';
}

export function convertedIds(audit: AuditRecord[]): Set<string> {
  return new Set(audit.filter(a => a.status === 'Completed').map(a => a.sourceId));
}

export function filterWorkspaces(workspaces: Workspace[], filters: Filters, converted: Set<string>): Workspace[] {
  const query = filters.search.trim().toLowerCase();
  return workspaces.filter(w => filters.stage === 'All stages' || w.stage === filters.stage)
    .map(w => ({ ...w, flows: w.flows.filter(f => {
      const state = converted.has(f.id) ? 'Converted' : f.compatibility;
      return (filters.compatibility === 'All statuses' || filters.compatibility === state)
        && (!query || `${f.name} ${w.name}`.toLowerCase().includes(query));
    }) })).filter(w => w.flows.length > 0);
}

export function isSelectable(flow: Dataflow, converted: Set<string>, running: Set<string>): boolean {
  return flow.origin !== 'live' && ['Ready', 'Needs review'].includes(flow.compatibility)
    && !converted.has(flow.id) && !running.has(flow.id);
}

export function toggleGroup(selected: Set<string>, ids: string[]): Set<string> {
  const next = new Set(selected);
  if (ids.length && ids.every(id => next.has(id))) ids.forEach(id => next.delete(id));
  else ids.forEach(id => next.add(id));
  return next;
}

export function makeAttempt(workspace: Workspace, flow: Dataflow, batchId: string, suffix: string): AuditRecord {
  if (flow.origin === 'live') throw new Error('Live inventory cannot be passed to the demo migration engine.');
  if (flow.compatibility === 'Blocked') throw new Error('Blocked dataflows cannot be migrated.');
  if (flow.compatibility === 'Not assessed') throw new Error('Assess compatibility before migration.');
  return {
    id: crypto.randomUUID(), batchId, sourceId: flow.id, sourceName: flow.name,
    workspaceId: workspace.id, workspaceName: workspace.name, stage: workspace.stage,
    status: 'Running', startedAt: new Date().toISOString(), completedAt: '',
    targetName: flow.name + suffix, targetId: '', actor: 'Demo operator', mode: 'Demo',
    details: 'Demo conversion started. No Fabric API calls are made.',
  };
}

export function toNotebookManifest(records: AuditRecord[]) {
  return records.map(a => ({
    DFG1_Name: a.sourceName, DFG1_ID: a.sourceId, Workspace_ID: a.workspaceId,
    WorkspaceName: a.workspaceName, DFG2_Name: a.targetName, DFG2_ID: a.targetId,
    Result: a.status === 'Completed' ? 'Succeed' : a.status === 'Failed' ? 'Fail' : 'Running',
    StatusText: a.details, Batch_ID: a.batchId, Mode: a.mode,
    StartedAt: a.startedAt, CompletedAt: a.completedAt, Actor: a.actor,
  }));
}
