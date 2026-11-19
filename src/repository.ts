import { RayfinClient, resolveRayfinConfig, suppliedToken } from '@microsoft/rayfin-client';
import { dataService } from '@microsoft/rayfin-data';
import { z } from 'zod';
import type { MigrationSchema } from '../rayfin/data/schema';
import { auditSchema, type AuditRecord } from './domain';

export interface AuditRepository {
  label: string;
  list(): Promise<AuditRecord[]>;
  save(record: AuditRecord): Promise<void>;
}

export const STORAGE_KEY = 'dfg2-migration-studio:audit:v1';
const storedSchema = z.object({ version: z.literal(1), records: z.array(auditSchema) });

export function browserRepository(storage: Storage): AuditRepository {
  const read = () => {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return storedSchema.parse(JSON.parse(raw)).records;
  };
  return {
    label: 'Browser storage',
    async list() { return read(); },
    async save(record) {
      const records = read();
      const index = records.findIndex(r => r.id === record.id);
      if (index < 0) records.push(auditSchema.parse(record));
      else records[index] = auditSchema.parse(record);
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, records }));
    },
  };
}

export async function createRepository(): Promise<AuditRepository> {
  const mode = import.meta.env.VITE_DATA_MODE || 'demo';
  if (mode === 'demo') return browserRepository(localStorage);
  if (mode !== 'rayfin') throw new Error(`Unknown data mode: ${mode}`);
  const apiUrl = import.meta.env.VITE_RAYFIN_API_URL;
  const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;
  const resolved = await resolveRayfinConfig({ apiUrl, publishableKey });
  if (!resolved.baseUrl || !resolved.publishableKey) throw new Error('Rayfin mode requires an API URL and publishable key.');
  const client = RayfinClient.create({
    baseUrl: resolved.baseUrl, publishableKey: resolved.publishableKey,
    runtimeConfig: resolved.runtimeConfig, auth: suppliedToken(),
    services: { data: dataService<MigrationSchema>() },
  });
  const known = new Set<string>();
  return {
    label: 'Rayfin Data API',
    async list() {
      const query = client.data.MigrationAttempt.select([
        'id', 'batchId', 'sourceId', 'sourceName', 'workspaceId', 'workspaceName',
        'stage', 'status', 'startedAt', 'completedAt', 'targetName', 'targetId', 'actor', 'details', 'mode',
      ]).orderBy({ startedAt: 'desc' }).first(100);
      const records: AuditRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await (cursor ? query.after(cursor) : query).executePaginated();
        records.push(...z.array(auditSchema).parse(page.items));
        if (records.length > 1000 || (records.length === 1000 && page.hasNextPage)) {
          throw new Error('Prototype history limit reached (1,000 records). Add server-side history views before continuing.');
        }
        if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) {
          throw new Error('Rayfin returned an invalid history pagination cursor.');
        }
        cursor = page.hasNextPage ? page.endCursor : undefined;
      } while (cursor);
      records.forEach(r => known.add(r.id));
      return records;
    },
    async save(record) {
      const parsed = auditSchema.parse(record);
      if (known.has(parsed.id)) {
        const { id, ...values } = parsed;
        await client.data.MigrationAttempt.update({ id }, values);
      } else {
        await client.data.MigrationAttempt.create(parsed);
        known.add(parsed.id);
      }
    },
  };
}
