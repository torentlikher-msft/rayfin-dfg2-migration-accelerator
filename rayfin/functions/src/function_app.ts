import { UserDataFunctions, type RayfinContext, type WithSql } from '@microsoft/fabric-user-data-functions';
import { z } from 'zod';
import { executionRequestSchema, liveRunSchema } from './contracts.js';
import type { MigrationSchema } from '../../data/schema.js';
import { executeRequest, microsoftApi, type RunStore } from './executionEngine.js';
import { assertDelegatedCaller, decryptDelegation, delegationKey } from './delegation.js';

const udf = new UserDataFunctions();
type Context = RayfinContext<MigrationSchema, never, 'USER_DELEGATION_PRIVATE_KEY'> & WithSql;
const fields = ['id', 'ownerId', 'action', 'workspaceId', 'workspaceName', 'status', 'startedAt', 'completedAt',
  'operationUrl', 'targetsJson', 'requestJson', 'resultJson', 'error'] as const;
const columns = fields.map(field => `[${field}]`).join(',');
const fromRow = (row: unknown[]) => liveRunSchema.parse(Object.fromEntries(fields.map((field, index) => [field, row[index]])));

function storeFor(ctx: Context): RunStore {
  return {
    async get(id) {
      const result = await ctx.sql.query(`SELECT ${columns} FROM dbo.LiveRuns WHERE id=@id AND ownerId=@ownerId`, { id, ownerId: ctx.user.id });
      return result.rows.length ? fromRow(result.rows[0]) : null;
    },
    async insert(run) {
      await ctx.sql.execute(`SET XACT_ABORT ON; BEGIN TRANSACTION;
        IF @action='upgrade' AND EXISTS (SELECT id FROM dbo.LiveRuns WITH (UPDLOCK,HOLDLOCK)
          WHERE ownerId=@ownerId AND workspaceId=@workspaceId AND action='upgrade'
          AND status IN ('Preparing','Submitting','Running','Verifying','Needs reconciliation'))
          BEGIN ROLLBACK; THROW 50001, 'Resume or reconcile the existing upgrade in this workspace first.', 1; END;
        INSERT INTO dbo.LiveRuns (${columns}) VALUES (${fields.map(field => '@' + field).join(',')}); COMMIT;`, { ...run, ownerId: ctx.user.id });
    },
    async save(run) {
      await ctx.sql.execute(`UPDATE dbo.LiveRuns SET ${fields.filter(field => field !== 'id' && field !== 'ownerId').map(field => `[${field}]=@${field}`).join(',')}
        WHERE id=@id AND ownerId=@ownerId`, { ...run, ownerId: ctx.user.id });
    },
  };
}

udf.func('executionKey', (ctx: RayfinContext<MigrationSchema, never, 'USER_DELEGATION_PRIVATE_KEY'>): { json: string } => {
  const key = delegationKey(ctx.Secrets.USER_DELEGATION_PRIVATE_KEY);
  return { json: JSON.stringify({ jwk: key.jwk }) };
}, []);

udf.func('executeLive', async (request: string, delegation: string, ctx: RayfinContext<MigrationSchema, never, 'USER_DELEGATION_PRIVATE_KEY'> & WithSql): Promise<{ json: string }> => {
  if (Buffer.byteLength(request) > 16_384 || delegation.length > 40_000) throw new Error('Execution request is too large.');
  const input = executionRequestSchema.parse(JSON.parse(request));
  const token = await decryptDelegation(request, delegation, ctx.user.id, ctx.Secrets.USER_DELEGATION_PRIVATE_KEY);
  await assertDelegatedCaller(token, ctx.user.id, ctx.baseUrl, ctx.publishableKey);
  const run = await executeRequest(input, ctx.user.id, storeFor(ctx), microsoftApi(token));
  return { json: JSON.stringify(run) };
}, []);

udf.func('executionHistory', async (cursor: string, ctx: RayfinContext<MigrationSchema> & WithSql): Promise<{ json: string }> => {
  const before = cursor ? z.object({ startedAt: z.string().datetime(), id: z.string().uuid() }).parse(JSON.parse(cursor)) : null;
  const result = await ctx.sql.query(`SELECT TOP 101 ${columns} FROM dbo.LiveRuns
    WHERE ownerId=@ownerId AND (@before='' OR startedAt<@before OR (startedAt=@before AND id<@beforeId))
    ORDER BY startedAt DESC,id DESC`, { ownerId: ctx.user.id, before: before?.startedAt ?? '', beforeId: before?.id ?? '00000000-0000-0000-0000-000000000000' });
  const records = result.rows.slice(0, 100).map(fromRow);
  const last = records.at(-1);
  return { json: JSON.stringify({ records, cursor: result.rows.length > 100 && last ? JSON.stringify({ startedAt: last.startedAt, id: last.id }) : '' }) };
}, []);
