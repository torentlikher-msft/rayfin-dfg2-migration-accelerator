import { useEffect, useState } from 'react';
import type { LiveRunRecord } from '../rayfin/functions/src/contracts';
import type { LiveBackend } from './liveClient';
import type { InventoryResult } from './tenantInventory';

type AssessmentBatch = {
  backend: LiveBackend;
  inventory: InventoryResult;
  completed: Map<string, string>;
  errors: Map<string, string>;
  current: string;
  finished: boolean;
};

export function useAutomaticAssessments(
  backend: LiveBackend | null, inventory: InventoryResult | null, remember: (run: LiveRunRecord) => void,
) {
  const [batch, setBatch] = useState<AssessmentBatch | null>(null);
  useEffect(() => {
    if (!backend || !inventory) return;
    let active = true;
    const completed = new Map<string, string>();
    const errors = new Map<string, string>();
    const workspaces = inventory.workspaces.filter(workspace => workspace.flows.length > 0);
    const update = (current: string, finished = false) => {
      if (active) setBatch({ backend, inventory, completed: new Map(completed), errors: new Map(errors), current, finished });
    };
    update('');
    void (async () => {
      await Promise.resolve();
      for (const workspace of workspaces) {
        if (!active) return;
        update(workspace.name);
        try {
          const run = await backend.execute({ action: 'assess', requestId: crypto.randomUUID(), workspaceId: workspace.id });
          if (!active) return;
          remember(run);
          if (run.status !== 'Completed') throw new Error(run.error || `Microsoft assessment is ${run.status}; review history.`);
          completed.set(workspace.id, run.id);
        } catch (reason) {
          if (!active) return;
          errors.set(workspace.id, `${workspace.name}: ${reason instanceof Error ? reason.message : String(reason)}`);
        }
        update('');
      }
      update('', true);
    })();
    return () => { active = false; };
  }, [backend, inventory, remember]);

  const current = batch?.backend === backend && batch?.inventory === inventory ? batch : null;
  const total = inventory?.workspaces.filter(workspace => workspace.flows.length > 0).length ?? 0;
  return {
    assessing: !!backend && total > 0 && !current?.finished,
    completed: current?.completed ?? new Map<string, string>(),
    errors: current?.errors ?? new Map<string, string>(),
    current: current?.current ?? '', total,
  };
}
