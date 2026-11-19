import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', ['read', 'create', 'update'])
export class MigrationAttempt {
  @uuid() id!: string;
  @uuid() batchId!: string;
  @text() sourceId!: string;
  @text() sourceName!: string;
  @text() workspaceId!: string;
  @text() workspaceName!: string;
  @text() stage!: string;
  @text() status!: string;
  @text() startedAt!: string;
  @text() completedAt!: string;
  @text() targetName!: string;
  @text() targetId!: string;
  @text() actor!: string;
  @text() details!: string;
  @text() mode!: string;
}
