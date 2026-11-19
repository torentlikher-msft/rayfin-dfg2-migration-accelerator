import type { AccountInfo, IPublicClientApplication } from '@azure/msal-browser';
import { z } from 'zod';

export const connectionSchema = z.object({
  tenantId: z.string().trim().uuid('Enter the Directory (tenant) ID from your Entra app registration.'),
  clientId: z.string().trim().uuid('Enter the Application (client) ID from your Entra SPA registration.'),
  includePipelines: z.boolean(),
});
export type ConnectionConfig = z.infer<typeof connectionSchema>;
export const CONNECTION_KEY = 'dfg2-migration-studio:entra-config:v1';
export const PBI_RESOURCE = 'https://analysis.windows.net/powerbi/api';

export function inventoryScopes(includePipelines: boolean): string[] {
  return ['Workspace.Read.All', 'Dataflow.Read.All', ...(includePipelines ? ['Pipeline.Read.All'] : [])]
    .map(scope => `${PBI_RESOURCE}/${scope}`);
}

export function executionScopes(): string[] {
  return ['Workspace.Read.All', 'Dataflow.ReadWrite.All', 'Item.Execute.All'].map(scope => `${PBI_RESOURCE}/${scope}`);
}

export function connectionScopes(includePipelines: boolean): string[] {
  return [...new Set([...inventoryScopes(includePipelines), ...executionScopes()])];
}

export interface TenantSession {
  account: Pick<AccountInfo, 'name' | 'username' | 'tenantId' | 'homeAccountId'>;
  config: ConnectionConfig;
  getToken(): Promise<string>;
  getExecutionToken?(): Promise<string>;
  disconnect(): Promise<void>;
}

let cached: { key: string; client: Promise<IPublicClientApplication> } | undefined;

async function authClient(config: ConnectionConfig) {
  const key = `${config.tenantId}:${config.clientId}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      client: import('@azure/msal-browser').then(({ createStandardPublicClientApplication, BrowserCacheLocation }) => createStandardPublicClientApplication({
        auth: {
          clientId: config.clientId,
          authority: `https://login.microsoftonline.com/${config.tenantId}`,
          redirectUri: new URL('redirect.html', document.baseURI).href,
        },
        cache: { cacheLocation: BrowserCacheLocation.SessionStorage },
        system: { enableLegacyPolling: true, popupBridgeTimeout: 300_000 },
      })),
    };
  }

  try { return await cached.client; }
  catch (error) { cached = undefined; throw error; }
}

export async function prepareTenant(config: ConnectionConfig): Promise<void> {
  await authClient(connectionSchema.parse(config));
}

export function signInFailureMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'errorCode' in error) {
    if (error.errorCode === 'timed_out') {
      return 'Microsoft sign-in timed out. Close old sign-in windows and reconnect. Complete sign-in in the Microsoft popup, and allow popups for this app if your browser blocks them. (timed_out)';
    }
    if (error.errorCode === 'popup_window_error') {
      return 'Your browser could not open Microsoft sign-in. Allow popups for this app, then choose Reconnect. (popup_window_error)';
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function sessionFor(client: IPublicClientApplication, account: AccountInfo, config: ConnectionConfig): TenantSession {
  if (account.tenantId.toLowerCase() !== config.tenantId.toLowerCase()) {
    throw new Error('The signed-in account does not belong to the configured resource tenant.');
  }
  client.setActiveAccount(account);
  async function tokenFor(scopes: string[]) {
    try {
      const result = await client.acquireTokenSilent({ account, scopes });
      if (result.account?.homeAccountId !== account.homeAccountId || result.account.tenantId.toLowerCase() !== config.tenantId.toLowerCase()) {
        throw new Error('The token returned a different Microsoft account. Reconnect before continuing.');
      }
      return result.accessToken;
    } catch (error) {
      const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
      if (error instanceof InteractionRequiredAuthError) {
        throw new Error('Microsoft sign-in or consent is required again. Choose Reconnect to enable inventory and live actions together.');
      }
      throw error;
    }
  }
  return {
    account, config,
    getExecutionToken: () => tokenFor(executionScopes()),
    getToken: () => tokenFor(inventoryScopes(config.includePipelines)),
    async disconnect() {
      // Disconnect this application, without signing the user out of other Microsoft apps.
      await client.clearCache({ account });
      client.setActiveAccount(null);
    },
  };
}

export async function signInTenant(input: ConnectionConfig): Promise<TenantSession> {
  const config = connectionSchema.parse({ ...input, includePipelines: true });
  const client = await authClient(config);
  const result = await client.loginPopup({ scopes: connectionScopes(config.includePipelines), prompt: 'select_account' });
  if (!result.account) throw new Error('Microsoft sign-in returned no user account.');
  const session = sessionFor(client, result.account, config);
  localStorage.setItem(CONNECTION_KEY, JSON.stringify(config));
  return session;
}

export function savedConnection(): ConnectionConfig | null {
  const raw = localStorage.getItem(CONNECTION_KEY);
  if (raw) return connectionSchema.parse({ ...JSON.parse(raw), includePipelines: true });
  if (import.meta.env.VITE_ENTRA_TENANT_ID || import.meta.env.VITE_ENTRA_CLIENT_ID) {
    return connectionSchema.parse({
      tenantId: import.meta.env.VITE_ENTRA_TENANT_ID,
      clientId: import.meta.env.VITE_ENTRA_CLIENT_ID,
      includePipelines: true,
    });
  }
  return null;
}

export async function restoreTenant(config: ConnectionConfig): Promise<TenantSession | null> {
  const client = await authClient(config);
  const active = client.getActiveAccount();
  // Never pick an arbitrary cached identity when more than one account is present.
  const accounts = client.getAllAccounts().filter(a => a.tenantId.toLowerCase() === config.tenantId.toLowerCase());
  const account = active?.tenantId.toLowerCase() === config.tenantId.toLowerCase()
    ? active : accounts.length === 1 ? accounts[0] : null;
  return account ? sessionFor(client, account, config) : null;
}
