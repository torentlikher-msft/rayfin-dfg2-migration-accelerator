import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const msal = vi.hoisted(() => ({
  create: vi.fn(), login: vi.fn(), consent: vi.fn(), token: vi.fn(), clear: vi.fn(), active: vi.fn(), accounts: vi.fn(), setActive: vi.fn(),
  InteractionRequired: class extends Error {},
}));
vi.mock('@azure/msal-browser', () => ({
  createStandardPublicClientApplication: msal.create,
  BrowserCacheLocation: { SessionStorage: 'sessionStorage' },
  InteractionRequiredAuthError: msal.InteractionRequired,
}));

const config = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  clientId: '00000000-0000-4000-8000-000000000002', includePipelines: true,
};
const account = { username: 'operator@example.test', name: 'Test operator', tenantId: config.tenantId, homeAccountId: 'test-account' };

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
  vi.stubGlobal('document', { baseURI: 'http://localhost:5173/' });
  const top = {};
  vi.stubGlobal('window', { self: top, top });
  msal.create.mockResolvedValue({
    loginPopup: msal.login, acquireTokenPopup: msal.consent, acquireTokenSilent: msal.token, clearCache: msal.clear,
    getActiveAccount: msal.active, getAllAccounts: msal.accounts, setActiveAccount: msal.setActive,
  });
  msal.login.mockResolvedValue({ account });
  msal.consent.mockResolvedValue({ account, accessToken: 'execution-user-token' });
  msal.token.mockResolvedValue({ account, accessToken: 'test-user-token' });
  msal.clear.mockResolvedValue(undefined);
  msal.active.mockReturnValue(null);
  msal.accounts.mockReturnValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe('delegated Microsoft account authentication', () => {
  it('requests inventory and execution consent together without a second popup and rejects an account change', async () => {
    const { signInTenant, connectionScopes, executionScopes } = await import('./tenantAuth');
    const session = await signInTenant(config);
    expect(msal.login).toHaveBeenCalledWith({ prompt: 'select_account', scopes: connectionScopes(true) });
    expect(msal.consent).not.toHaveBeenCalled();
    expect(await session.getExecutionToken!()).toBe('test-user-token');
    expect(msal.token).toHaveBeenCalledWith({ account, scopes: executionScopes() });
    expect(executionScopes()).toContain('https://analysis.windows.net/powerbi/api/Item.Execute.All');
    msal.token.mockResolvedValue({ account: { ...account, homeAccountId: 'other-user' }, accessToken: 'other-user-token' });
    await expect(session.getExecutionToken!()).rejects.toThrow('different Microsoft account');
    await expect(session.getToken()).rejects.toThrow('different Microsoft account');
    expect(msal.consent).not.toHaveBeenCalled();
  });
  it('uses the selected user for inventory and persists only public configuration', async () => {
    const { signInTenant, CONNECTION_KEY } = await import('./tenantAuth');
    const session = await signInTenant(config);
    expect(await session.getToken()).toBe('test-user-token');
    expect(msal.login).toHaveBeenCalledWith({ prompt: 'select_account', scopes: [
      'https://analysis.windows.net/powerbi/api/Workspace.Read.All',
      'https://analysis.windows.net/powerbi/api/Dataflow.Read.All',
      'https://analysis.windows.net/powerbi/api/Pipeline.Read.All',
      'https://analysis.windows.net/powerbi/api/Dataflow.ReadWrite.All',
      'https://analysis.windows.net/powerbi/api/Item.Execute.All',
    ] });
    expect(msal.token.mock.calls[0][0].account).toBe(account);
    expect(msal.create.mock.calls[0][0]).toMatchObject({
      auth: { redirectUri: 'http://localhost:5173/redirect.html', authority: `https://login.microsoftonline.com/${config.tenantId}` },
      cache: { cacheLocation: 'sessionStorage' },
      system: { enableLegacyPolling: true, popupBridgeTimeout: 300_000 },
    });
    expect(msal.create.mock.calls[0][0].auth.popupRelayUri).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(CONNECTION_KEY)!)).toEqual(config);
    await session.disconnect();
    expect(msal.clear).toHaveBeenCalledWith({ account });
    expect(msal.setActive).toHaveBeenLastCalledWith(null);
  });

  it('uses direct Microsoft popup polling without a relay when embedded', async () => {
    vi.stubGlobal('window', { self: {}, top: {} });
    const { prepareTenant } = await import('./tenantAuth');
    await prepareTenant(config);
    expect(msal.create.mock.calls[0][0].auth).toMatchObject({
      redirectUri: 'http://localhost:5173/redirect.html',
    });
    expect(msal.create.mock.calls[0][0].auth.popupRelayUri).toBeUndefined();
    expect(msal.create.mock.calls[0][0].system.enableLegacyPolling).toBe(true);
  });

  it('gives actionable timeout and popup-blocking messages', async () => {
    const { signInFailureMessage } = await import('./tenantAuth');
    expect(signInFailureMessage({ errorCode: 'timed_out' })).toContain('Complete sign-in in the Microsoft popup');
    expect(signInFailureMessage({ errorCode: 'popup_window_error' })).toContain('Allow popups');
    expect(signInFailureMessage(new Error('Other Microsoft error'))).toBe('Other Microsoft error');
  });

  it('never restores an arbitrary account when several identities are cached', async () => {
    msal.accounts.mockReturnValue([account, { ...account, homeAccountId: 'another-account' }]);
    const { restoreTenant } = await import('./tenantAuth');
    expect(await restoreTenant(config)).toBeNull();
    expect(msal.login).not.toHaveBeenCalled();
  });

  it('rejects a user token for a different tenant', async () => {
    msal.login.mockResolvedValue({ account: { ...account, tenantId: '00000000-0000-4000-8000-000000000099' } });
    const { signInTenant } = await import('./tenantAuth');
    await expect(signInTenant(config)).rejects.toThrow('configured resource tenant');
  });

  it('requests explicit reconnection when silent user authentication needs interaction', async () => {
    msal.token.mockRejectedValue(new msal.InteractionRequired('consent required'));
    const { signInTenant } = await import('./tenantAuth');
    const session = await signInTenant({ ...config, includePipelines: false });
    await expect(session.getToken()).rejects.toThrow('Choose Reconnect');
    await expect(session.getExecutionToken!()).rejects.toThrow('Choose Reconnect');
    expect(msal.consent).not.toHaveBeenCalled();
    expect(msal.login).toHaveBeenCalledTimes(1);
    expect(msal.login.mock.calls[0][0].scopes).toContain('https://analysis.windows.net/powerbi/api/Pipeline.Read.All');
    expect(session.config.includePipelines).toBe(true);
  });

  it('upgrades a saved connection with pipeline stages disabled to always include them', async () => {
    const { savedConnection, CONNECTION_KEY } = await import('./tenantAuth');
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({ ...config, includePipelines: false }));
    expect(savedConnection()?.includePipelines).toBe(true);
  });
});
