import { z } from 'zod';
import type { Dataflow, Workspace } from './domain';
import type { TenantSession } from './tenantAuth';

const API = 'https://api.powerbi.com/v1.0/myorg/';
const envelope = z.object({ value: z.array(z.unknown()), '@odata.nextLink': z.string().nullish() });
const groupSchema = z.object({
  id: z.string().uuid(), name: z.string(), isOnDedicatedCapacity: z.boolean().optional(),
  capacityId: z.string().optional(),
});
const dataflowSchema = z.object({
  objectId: z.string().uuid(), name: z.string(), description: z.string().nullish(),
  configuredBy: z.string().nullish(), generation: z.union([z.number(), z.string()]).nullish(),
  modifiedDateTime: z.string().datetime({ offset: true }).nullish(),
});
const pipelineSchema = z.object({ id: z.string().uuid(), displayName: z.string() });
const stageSchema = z.object({
  order: z.number().int().nonnegative(), workspaceId: z.string().uuid().nullish(),
  displayName: z.string().nullish(),
});

export interface InventoryResult {
  workspaces: Workspace[];
  warnings: string[];
  accessibleWorkspaces: number;
  skippedGen2: number;
  retrievedAt: string;
}

export class InventoryApiError extends Error {
  constructor(public readonly status: number, public readonly path: string, message: string) {
    super(`${message} (HTTP ${status})`);
  }
}

export function trustedInventoryUrl(path: string): URL {
  const url = new URL(path, API);
  if (url.origin !== new URL(API).origin || !url.pathname.startsWith('/v1.0/myorg/') || url.username || url.password) {
    throw new Error('The inventory API returned an untrusted pagination URL.');
  }
  return url;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function parallelMap<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  }));
  return results;
}

export async function discoverInventory(session: TenantSession, signal: AbortSignal): Promise<InventoryResult> {
  async function get(path: string): Promise<unknown> {
    const url = trustedInventoryUrl(path);
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const token = await session.getToken();
      signal.throwIfAborted();
      const response = await fetch(url, { signal, redirect: 'error', headers: { Authorization: `Bearer ${token}` } });
      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        const retryAfter = response.headers.get('Retry-After');
        const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
        const date = retryAfter ? Date.parse(retryAfter) : NaN;
        const pause = seconds !== null ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000 * 2 ** attempt;
        await delay(pause, signal);
        continue;
      }
      if (!response.ok) {
        throw new InventoryApiError(response.status, url.pathname,
          response.status === 401 ? 'Your user session expired or the token was rejected. Reconnect to Microsoft'
            : response.status === 403 ? 'Your account does not have permission to read this resource'
              : `Power BI inventory request failed: ${url.pathname}`);
      }
      return response.json();
    }
    throw new Error('Inventory request exhausted its retries.');
  }

  async function list<T>(path: string, schema: z.ZodType<T>, offsetPaging = false, identity?: (item: T) => string): Promise<T[]> {
    const records: T[] = [];
    const seen = new Set<string>();
    const seenIds = new Set<string>();
    let url = path;
    for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
      const requestUrl = trustedInventoryUrl(url);
      if (seen.has(requestUrl.href)) throw new Error('The inventory API repeated a pagination URL.');
      seen.add(requestUrl.href);
      const page = envelope.parse(await get(requestUrl.href));
      const parsed = page.value.map(item => schema.parse(item));
      if (identity) {
        for (const item of parsed) {
          const id = identity(item);
          if (seenIds.has(id)) throw new Error('Inventory pagination returned duplicate record IDs. Refresh before continuing.');
          seenIds.add(id);
        }
      }
      records.push(...parsed);
      if (page['@odata.nextLink']) url = page['@odata.nextLink'];
      else if (offsetPaging && page.value.length === 100) {
        const next = trustedInventoryUrl(path);
        next.searchParams.set('$top', '100');
        next.searchParams.set('$skip', String(records.length));
        url = next.href;
      } else return records;
    }
    throw new Error('Inventory page limit reached. Discovery was stopped instead of returning a truncated result.');
  }

  const warnings: string[] = [];
  const groups = await list('groups?$top=100&$skip=0', groupSchema, true, group => group.id);
  const memberships = new Map<string, { pipeline: string; stage: string }>();
  if (session.config.includePipelines) {
    try {
      const pipelines = await list('pipelines', pipelineSchema);
      const pipelineStages = await parallelMap(pipelines, async pipeline => ({
        pipeline,
        stages: await list(`pipelines/${pipeline.id}/stages`, stageSchema),
      }));
      for (const { pipeline, stages } of pipelineStages) {
        for (const stage of stages) {
          if (!stage.workspaceId) continue;
          // Legacy API stages have a fixed Development/Test/Production order.
          // Preserve explicit names when the API supplies them instead.
          const label = stage.displayName || (stages.length === 3 ? ['Development', 'Test', 'Production'][stage.order] : undefined)
            || `Stage ${stage.order + 1}`;
          memberships.set(stage.workspaceId, { pipeline: pipeline.displayName, stage: label });
        }
      }
      warnings.push('Pipeline stages reflect only pipelines visible to your account. Unknown means membership was not verified, not necessarily unassigned.');
    } catch (error) {
      if (!(error instanceof InventoryApiError) || error.status === 401) throw error;
      memberships.clear();
      warnings.push(`Pipeline discovery unavailable: ${error.message}. Inventory is still loaded; stages are Unknown.`);
    }
  } else {
    warnings.push('Pipeline discovery is turned off. Deployment stages are Unknown.');
  }

  let skippedGen2 = 0;
  const loaded = await parallelMap(groups, async group => {
    let flows: Dataflow[] = [];
    try {
      const records = await list(`groups/${group.id}/dataflows`, dataflowSchema, false, record => record.objectId);
      flows = records.flatMap(record => {
        const generation = Number(record.generation);
        if (generation === 2) { skippedGen2++; return []; }
        return [{
          id: record.objectId, name: record.name,
          source: 'Not inspected', entities: null, compatibility: 'Not assessed' as const,
          issues: ['Live inventory only. Compatibility and permission to migrate have not been assessed.'],
          modified: record.modifiedDateTime || null, origin: 'live' as const,
          generation: generation === 1 ? 1 as const : null,
          configuredBy: record.configuredBy || undefined, description: record.description || undefined,
        }];
      });
    } catch (error) {
      if (!(error instanceof InventoryApiError) || error.status === 401) throw error;
      warnings.push(`${group.name}: dataflows could not be read. ${error.message}. This workspace is omitted from the results.`);
      return null;
    }
    const membership = memberships.get(group.id);
    return {
      id: group.id, name: group.name, domain: 'Live workspace',
      pipeline: membership?.pipeline ?? 'Not discovered', stage: membership?.stage ?? 'Unknown',
      capacity: group.isOnDedicatedCapacity === undefined ? 'Not provided'
        : group.isOnDedicatedCapacity ? 'Dedicated capacity' : 'Shared capacity',
      flows,
    } satisfies Workspace;
  });
  signal.throwIfAborted();
  if (groups.length && loaded.every(w => w === null)) {
    throw new Error(`Inventory is unavailable for all ${groups.length} accessible workspaces. Check your account permissions and reconnect.`);
  }
  return {
    workspaces: loaded.filter((w): w is NonNullable<typeof w> => w !== null && w.flows.length > 0),
    warnings, accessibleWorkspaces: groups.length, skippedGen2, retrievedAt: new Date().toISOString(),
  };
}
