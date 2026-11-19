import { z } from 'zod';

export const readinessReasonSchema = z.object({ code: z.string(), message: z.string(), status: z.string() }).passthrough();
export const readinessSchema = z.object({
  id: z.string().uuid(), displayName: z.string(), status: z.string(),
  reasons: z.array(readinessReasonSchema).nullish(),
}).passthrough();
export const readinessPageSchema = z.object({
  value: z.array(readinessSchema), continuationUri: z.string().nullish(), continuationToken: z.string().nullish(),
});
export const migrationSchema = z.object({
  dataflowId: z.string().uuid(), dataflowName: z.string(), workspaceId: z.string().uuid(),
  workspaceName: z.string(), targetDataflowName: z.string().nullish(), migrationStatus: z.string(),
  assessmentStatus: z.string().nullish(), migrationEndDateTime: z.string().nullish(),
  migrationError: z.object({ errorCode: z.string(), message: z.string(), isRetriable: z.boolean() }).passthrough().nullish(),
  requiredActions: z.array(readinessReasonSchema).nullish(),
}).passthrough();
export const upgradeResultSchema = z.object({
  migrations: z.array(migrationSchema),
  summary: z.object({ totalCount: z.number(), succeededCount: z.number(), failedCount: z.number() }),
}).passthrough();
export const gen2ReadbackSchema = z.object({ id: z.string().uuid(), displayName: z.string(), type: z.literal('Dataflow') });
export const savedUpgradeSchema = z.object({
  targetNames: z.record(z.string()).optional(),
  apiResult: upgradeResultSchema.optional(),
  tracking: z.object({
    nextPollAt: z.string().datetime(),
    operationState: z.object({ status: z.string() }).passthrough().optional(),
  }).optional(),
  reconciliation: z.object({
    method: z.literal('SameIdGen2Readback'), operationUrl: z.string().url(), operationError: z.string(),
    checkedAt: z.string().datetime(), items: z.array(gen2ReadbackSchema), unverifiedIds: z.array(z.string().uuid()),
  }).optional(),
  verifiedGen2Ids: z.array(z.string().uuid()),
}).refine(value => !(value.apiResult && value.reconciliation) && !!(value.apiResult || value.tracking || value.reconciliation || value.targetNames),
  'Expected an API outcome, operation tracking, or explicitly labelled Gen2 reconciliation.');
export const executionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assess'), requestId: z.string().uuid(), workspaceId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('upgrade'), requestId: z.string().uuid(), workspaceId: z.string().uuid(),
    ids: z.array(z.string().uuid()).min(1).max(50), assessmentId: z.string().uuid(),
    acknowledgeInPlace: z.literal(true), acknowledgeAttention: z.boolean(),
  }).strict(),
  z.object({ action: z.literal('poll'), requestId: z.string().uuid(), workspaceId: z.string().uuid() }).strict(),
]);
export const liveRunSchema = z.object({
  id: z.string().uuid(), ownerId: z.string(), action: z.string(), workspaceId: z.string(), workspaceName: z.string(),
  status: z.string(), startedAt: z.string(), completedAt: z.string(), operationUrl: z.string(),
  targetsJson: z.string(), requestJson: z.string(), resultJson: z.string(), error: z.string(),
});
export type Readiness = z.infer<typeof readinessSchema>;
export type UpgradeResult = z.infer<typeof upgradeResultSchema>;
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type LiveRunRecord = z.infer<typeof liveRunSchema>;
export function apiAllowsUpgrade(readiness: Readiness): boolean {
  return readiness.status === 'ReadyToMigrate' || readiness.status === 'NeedsAttention';
}
