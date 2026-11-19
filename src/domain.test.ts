import { describe, expect, it } from 'vitest';
import { workspaces } from './data';
import { convertedIds, filterWorkspaces, isSelectable, makeAttempt, toggleGroup, toNotebookManifest } from './domain';

describe('workspace discovery and migration selection', () => {
  it('combines stage, compatibility and case-insensitive dataflow search', () => {
    const result = filterWorkspaces(workspaces, {
      stage: 'Production', compatibility: 'Needs review', search: ' REVENUE ',
    }, new Set());
    expect(result.map(w => [w.name, w.flows.map(f => f.name)]))
      .toEqual([['Sales Analytics', ['Revenue forecast']]]);
    expect(filterWorkspaces(workspaces, { stage: 'Test', compatibility: 'Ready', search: 'Revenue' }, new Set())).toEqual([]);
  });

  it('finds all matching flows by workspace name and supports unassigned stage', () => {
    expect(filterWorkspaces(workspaces, {
      stage: 'Unassigned', compatibility: 'All statuses', search: 'people',
    }, new Set())[0].flows).toHaveLength(3);
  });

  it('excludes blocked, converted and in-flight flows from workspace selection', () => {
    const workspace = workspaces[0];
    const converted = new Set(['sales-orders']);
    const running = new Set(['customer-360']);
    const ids = workspace.flows.filter(f => isSelectable(f, converted, running)).map(f => f.id);
    expect(ids).toEqual(['revenue-forecast', 'territory-mapping']);
    const selected = toggleGroup(new Set(['general-ledger', 'revenue-forecast']), ids);
    expect([...selected]).toEqual(['general-ledger', 'revenue-forecast', 'territory-mapping']);
    expect([...toggleGroup(selected, ids)]).toEqual(['general-ledger']);
    expect([...toggleGroup(selected, [])]).toEqual([...selected]);
  });

  it('derives converted status only from completed attempts', () => {
    const pending = makeAttempt(workspaces[0], workspaces[0].flows[0], crypto.randomUUID(), '_DFG2');
    expect(convertedIds([pending])).toEqual(new Set());
    const converted = convertedIds([{ ...pending, status: 'Completed' }]);
    const result = filterWorkspaces(workspaces, { stage: 'All stages', compatibility: 'Converted', search: '' }, converted);
    expect(result[0].flows.map(f => f.id)).toEqual(['sales-orders']);
    const ready = filterWorkspaces(workspaces, { stage: 'All stages', compatibility: 'Ready', search: 'sales orders' }, converted);
    expect(ready).toEqual([]);
  });

  it('rejects blocked conversion and exports explicit demo source-to-target mapping', () => {
    expect(() => makeAttempt(workspaces[0], workspaces[0].flows[4], crypto.randomUUID(), '_G2')).toThrow('Blocked');
    const attempt = makeAttempt(workspaces[0], workspaces[0].flows[0], crypto.randomUUID(), '_G2');
    const [exported] = toNotebookManifest([{ ...attempt, status: 'Completed', targetId: 'demo-target' }]);
    expect(exported).toMatchObject({
      DFG1_Name: 'Sales orders', DFG1_ID: 'sales-orders', Workspace_ID: 'ws-sales-prod',
      DFG2_Name: 'Sales orders_G2', DFG2_ID: 'demo-target', Result: 'Succeed', Mode: 'Demo',
    });
  });
});
