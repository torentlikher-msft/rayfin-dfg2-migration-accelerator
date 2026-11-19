import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', 'read', { policy: (claims, item) => claims.sub.eq(item.ownerId) })
export class LiveRun {
  @uuid() id!: string;
  @text() ownerId!: string;
  @text() action!: string;
  @text() workspaceId!: string;
  @text() workspaceName!: string;
  @text() status!: string;
  @text() startedAt!: string;
  @text() completedAt!: string;
  @text() operationUrl!: string;
  @text() targetsJson!: string;
  @text() requestJson!: string;
  @text() resultJson!: string;
  @text() error!: string;
}
