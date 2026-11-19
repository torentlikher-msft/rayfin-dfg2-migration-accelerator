import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { decryptDelegation, delegationKey } from '../rayfin/functions/src/delegation';
import { executeRequest, MicrosoftApiError, type MicrosoftApi, type RunStore } from '../rayfin/functions/src/executionEngine';
import { executionRequestSchema, type LiveRunRecord, type Readiness } from '../rayfin/functions/src/contracts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const clientId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000010';
const flowId = '00000000-0000-4000-8000-000000000020';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ tenantId, clientId }) => localStorage.setItem('dfg2-migration-studio:entra-config:v1', JSON.stringify({ tenantId, clientId, includePipelines: true })), { tenantId, clientId });
});

async function liveBoundary(page: Page) {
  const assessments: string[] = [];
  const failedWorkspaces = new Set<string>();
  const readiness = new Map<string, Readiness[]>([[workspaceId, [{ id: flowId, displayName: 'Actual finance flow', status: 'ReadyToMigrate' }]]]);
  const records = new Map<string, LiveRunRecord>();
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'browser-live-key' };
  const accessToken = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ sub: 'browser-test-user', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'test-signature'].join('.');
  await page.route('**/rayfin.config.json', route => route.fulfill({ json: { apiUrl: 'https://backend.example.test/app/', publishableKey: 'pk-browser-test' } }));
  await page.route('https://backend.example.test/app/**', async route => {
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': request.headers()['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/brokered/token')) {
      expect(request.headers().authorization).toBe('Bearer browser-test-execution-token');
      await route.fulfill({ headers, json: { accessToken, tokenType: 'Bearer', expiresIn: 3600 } }); return;
    }
    expect(request.headers().authorization).toBe(`Bearer ${accessToken}`);
    let output: { json: string } | null = null;
    if (path.includes('/executionKey/')) output = { json: JSON.stringify({ jwk }) };
    else if (path.includes('/executionHistory/')) output = { json: JSON.stringify({ records: [...records.values()], cursor: '' }) };
    else if (path.includes('/executeLive/')) {
      const input = request.postDataJSON() as { request: string; delegation: string };
      const execution = executionRequestSchema.parse(JSON.parse(input.request));
      expect(execution.action).toBe('assess');
      expect(request.postData()).not.toContain('browser-test-execution-token');
      assessments.push(execution.workspaceId);
      const failed = failedWorkspaces.has(execution.workspaceId);
      const now = new Date().toISOString();
      const record: LiveRunRecord = { id: execution.requestId, ownerId: 'browser-test-user', action: 'assess',
        workspaceId: execution.workspaceId, workspaceName: 'Real tenant finance', status: failed ? 'Failed' : 'Completed',
        startedAt: now, completedAt: now, operationUrl: '', targetsJson: '[]', requestJson: input.request,
        resultJson: failed ? '' : JSON.stringify({ value: readiness.get(execution.workspaceId) ?? [] }),
        error: failed ? 'Test Microsoft assessment failure' : '' };
      records.set(record.id, record);
      output = { json: JSON.stringify(record) };
    }
    expect(output, `Unexpected backend action: ${path}`).not.toBeNull();
    await route.fulfill({ headers, json: { status: 'Succeeded', output, errors: [], invocationId: 'live-connection-test' } });
  });
  return { assessments, failedWorkspaces, readiness, records };
}

async function microsoftBoundary(page: Page, deny = false) {
  // Only the external identity provider and API boundary are replaced; the app's
  // auth/session, inventory adapter, and live/demo UI paths run unchanged.
  await page.route('**/node_modules/.vite/deps/@azure_msal-browser.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      const user = { name: 'Tenant user', username: 'tenant-user@example.test', tenantId: '${tenantId}', homeAccountId: 'browser-test-user' };
      let active = sessionStorage.getItem('mock-msal-account') ? user : null;
      export const BrowserCacheLocation = { SessionStorage: 'sessionStorage' };
      export class InteractionRequiredAuthError extends Error {}
      export async function createStandardPublicClientApplication() {
        return {
          loginPopup: async ({scopes}) => {
            if (!scopes.some(x=>x.endsWith('/Item.Execute.All')) || !scopes.some(x=>x.endsWith('/Dataflow.ReadWrite.All'))) throw new Error('Missing unified consent');
            active = user; sessionStorage.setItem('mock-msal-account','1');
            sessionStorage.setItem('mock-msal-popup-count', String(Number(sessionStorage.getItem('mock-msal-popup-count') || 0) + 1));
            return { account: user };
          },
          acquireTokenPopup: async () => { throw new Error('Unexpected second interactive sign-in'); },
          acquireTokenSilent: async ({account,scopes}) => {
            if (account.homeAccountId !== user.homeAccountId) throw new Error('Wrong user');
            return { account: user, accessToken: scopes.some(x=>x.endsWith('/Dataflow.ReadWrite.All')) ? 'browser-test-execution-token' : 'browser-test-user-token' };
          },
          getActiveAccount: () => active,
          getAllAccounts: () => active ? [active] : [],
          setActiveAccount: value => { active = value; },
          clearCache: async () => { active = null; sessionStorage.removeItem('mock-msal-account'); },
        };
      }
    `,
  }));
  const backend = await liveBoundary(page);
  await page.route('https://api.powerbi.com/v1.0/myorg/**', async route => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    expect(route.request().headers().authorization).toBe('Bearer browser-test-user-token');
    const url = new URL(route.request().url());
    let value: unknown[] = [];
    if (url.pathname.endsWith('/groups')) value = [{ id: workspaceId, name: 'Real tenant finance', isOnDedicatedCapacity: true }];
    else if (url.pathname.endsWith('/pipelines')) value = [{ id: clientId, displayName: 'Real finance pipeline' }];
    else if (url.pathname.endsWith('/stages')) value = [{ order: 0 }, { order: 1 }, { order: 2, workspaceId }];
    else value = [{ objectId: flowId, name: 'Actual finance flow', generation: 1, configuredBy: 'tenant-user@example.test' }];
    await route.fulfill({ status: deny ? 403 : 200, headers, json: { value } });
  });
  return backend;
}

async function connect(page: Page | FrameLocator) {
  await page.getByRole('button', { name: 'Connect tenant', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
}

async function workspaceBoundary(page: Page, workspaceCount = 3, flowCount = 20) {
  const backend = await microsoftBoundary(page);
  const workspaces = Array.from({ length: workspaceCount }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    name: `Long workspace ${index + 1}`, isOnDedicatedCapacity: true,
  }));
  const flows = new Map(workspaces.map((workspace, workspaceIndex) => [workspace.id,
    Array.from({ length: flowCount }, (_, index) => ({
      objectId: `00000000-0000-4000-8000-${String(workspaceIndex * flowCount + index + 100).padStart(12, '0')}`,
      name: `Long test flow ${index}`, generation: 1,
    })),
  ]));
  for (const workspace of workspaces) backend.readiness.set(workspace.id, flows.get(workspace.id)!.map((flow, index) => ({
    id: flow.objectId, displayName: flow.name, status: index < 5 ? 'ReadyToMigrate' : index < 10 ? 'NeedsAttention' : 'UpgradeUnavailable',
  })));
  await page.route('https://api.powerbi.com/v1.0/myorg/groups**', async route => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const path = new URL(route.request().url()).pathname;
    const value = path.endsWith('/groups') ? workspaces : flows.get(path.split('/')[4]) ?? [];
    await route.fulfill({ headers, json: { value } });
  });
  return { ...backend, workspaceIds: workspaces.map(workspace => workspace.id) };
}

test('all workspaces assess automatically once per inventory load with unfiltered ready counts and persistent migration controls', async ({ page }) => {
  const boundary = await workspaceBoundary(page);
  await page.goto('/');
  await connect(page);
  await expect(page.getByText('Readiness checked for 3 of 3 workspaces.', { exact: true })).toBeVisible();
  expect(boundary.assessments).toEqual(boundary.workspaceIds);
  await expect(page.locator('.workspace-toggle[aria-expanded="false"]')).toHaveCount(3);
  await expect(page.locator('.inventory-frame tbody')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select workspace Long workspace 1', exact: true }).check();
  for (const toggle of await page.locator('.workspace-toggle').all()) await toggle.click();
  const firstHeader = page.locator('.workspace-header').first();
  await expect(firstHeader).toContainText('20 dataflows');
  await expect(firstHeader).toContainText('5 ready to migrate');
  await page.getByRole('checkbox', { name: 'Select workspace Long workspace 1', exact: true }).check();
  await expect(page.locator('.selection-bar')).toContainText('5 selected');
  const migrate = page.locator('.inventory-heading').getByRole('button', { name: 'Migrate selected' });
  await expect(migrate).toBeEnabled();
  const frame = page.getByRole('region', { name: 'Workspace dataflows' });
  await migrate.scrollIntoViewIfNeeded();
  const originalY = (await migrate.boundingBox())!.y;
  await frame.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await frame.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect((await migrate.boundingBox())!.y).toBeCloseTo(originalY);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect((await migrate.boundingBox())!.y).toBeGreaterThanOrEqual(45);
  await expect(migrate).toBeInViewport();
  const toolbarBounds = (await page.locator('.toolbar').boundingBox())!;
  expect(toolbarBounds.y).toBe(45);
  expect((await migrate.boundingBox())!.y).toBeGreaterThanOrEqual(toolbarBounds.y + toolbarBounds.height);
  await page.setViewportSize({ width: 390, height: 844 });
  await migrate.scrollIntoViewIfNeeded();
  await frame.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(migrate).toBeInViewport();
  await page.locator('.workspace-ready').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.workspace-ready').last()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('textbox', { name: 'Search dataflows', exact: true }).fill('Long test flow 0');
  await expect(firstHeader).toContainText('20 dataflows');
  await expect(firstHeader).toContainText('5 ready to migrate');
  await page.getByRole('textbox', { name: 'Search dataflows', exact: true }).fill('');
  await page.getByLabel('Migration compatibility status', { exact: true }).selectOption('NeedsAttention');
  await expect(firstHeader).toContainText('5 ready to migrate');
  await page.getByLabel('Deployment pipeline stage', { exact: true }).selectOption('Production');
  await expect(page.locator('.workspace-header')).toHaveCount(1);
  await page.getByRole('button', { name: /Long workspace 1 20 dataflows/ }).click();
  await page.getByRole('button', { name: 'Migration history' }).first().click();
  await expect(page.getByRole('cell', { name: 'API assessment', exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Migration workbench' }).click();
  expect(boundary.assessments).toEqual(boundary.workspaceIds);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Readiness checked for 3 of 3 workspaces.', { exact: true })).toBeVisible();
  expect(boundary.assessments).toEqual([...boundary.workspaceIds, ...boundary.workspaceIds]);
});

test('an automatic assessment failure does not reuse historical readiness or stop other workspaces and refresh retries it', async ({ page }) => {
  const boundary = await workspaceBoundary(page, 2, 2);
  await page.goto('/');
  await connect(page);
  await expect(page.getByText('Readiness checked for 2 of 2 workspaces.', { exact: true })).toBeVisible();
  boundary.failedWorkspaces.add(boundary.workspaceIds[0]);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Readiness checked for 1 of 2 workspaces; 1 failed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Test Microsoft assessment failure');
  const first = page.locator('.workspace-group').first();
  await expect(first.locator('.workspace-ready')).toHaveText('Assessment failed');
  await expect(first.getByRole('checkbox').first()).toBeDisabled();
  await expect(first.getByText('ReadyToMigrate', { exact: true })).toHaveCount(0);
  await expect(page.locator('.workspace-ready').last()).toHaveText('2 ready to migrate');
  expect(boundary.assessments).toHaveLength(4);
  boundary.failedWorkspaces.clear();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Readiness checked for 2 of 2 workspaces.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(first.locator('.workspace-ready')).toHaveText('2 ready to migrate');
  expect(boundary.assessments).toHaveLength(6);
});

test('disconnecting during automatic assessment stops queued workspaces and ignores a late result', async ({ page }) => {
  const boundary = await workspaceBoundary(page, 3, 1);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  let finished!: () => void;
  const returned = new Promise<void>(resolve => { finished = resolve; });
  await page.route('https://backend.example.test/app/**/executeLive/**', async route => {
    if (route.request().method() === 'OPTIONS') { await route.fallback(); return; }
    started();
    await pending;
    await route.fallback();
    finished();
  });
  await page.goto('/');
  await connect(page);
  await requested;
  try {
    await expect(page.getByRole('button', { name: 'Migrate selected' })).toBeDisabled();
    await page.getByRole('button', { name: 'Disconnect tenant', exact: true }).click();
  } finally { release(); }
  await returned;
  await expect(page.getByRole('button', { name: 'Sales orders Dataflow Gen1' })).toHaveCount(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(boundary.assessments).toEqual([boundary.workspaceIds[0]]);
  await expect(page.getByText('Signed in as tenant-user@example.test')).toHaveCount(0);
});

test('workspace selection includes only ready items and preserves individually selected attention items', async ({ page }) => {
  await workspaceBoundary(page, 1, 20);
  await page.goto('/');
  await connect(page);
  await expect(page.getByText('Readiness checked for 1 of 1 workspaces.', { exact: true })).toBeVisible();
  await page.locator('.workspace-toggle').first().click();
  const group = page.getByRole('checkbox', { name: 'Select workspace Long workspace 1', exact: true });
  await group.check();
  await expect(page.getByRole('checkbox', { name: 'Select Long test flow 0', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select Long test flow 5', exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Migrate selected' })).toContainText('5');
  await page.getByRole('checkbox', { name: 'Select Long test flow 5', exact: true }).check();
  await group.uncheck();
  await expect(page.getByRole('checkbox', { name: 'Select Long test flow 0', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select Long test flow 5', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Migrate selected' }).click();
  await expect(page.getByRole('dialog')).toContainText('Long test flow 5');
  await expect(page.getByRole('dialog')).not.toContainText('Long test flow 0');
  await page.getByLabel('I understand this replaces Gen1 in place, rather than creating a copy.').check();
  await expect(page.getByRole('button', { name: 'Upgrade in place' })).toBeDisabled();
  await page.getByLabel('I have reviewed the Microsoft NeedsAttention reasons and required follow-ups.').check();
  await expect(page.getByRole('button', { name: 'Upgrade in place' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByLabel('Migration compatibility status', { exact: true }).selectOption('NeedsAttention');
  await expect(group).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Select Long test flow 5', exact: true })).toBeEnabled();
  await expect(page.getByRole('columnheader', { name: 'Readiness', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Microsoft readiness' })).toHaveCount(0);
});

test('history shows dataflow names beside workspace and scrolls inside its own frame', async ({ page }) => {
  const backend = await microsoftBoundary(page);
  for (let index = 0; index < 70; index++) {
    const id = `00000000-0000-4000-8000-${String(index + 500).padStart(12, '0')}`;
    const now = new Date(Date.now() - index * 1000).toISOString();
    backend.records.set(id, { id, ownerId: 'browser-test-user', action: 'assess', workspaceId, workspaceName: 'Real tenant finance',
      status: 'Completed', startedAt: now, completedAt: now, operationUrl: '', targetsJson: '[]',
      requestJson: JSON.stringify({ action: 'assess', requestId: id, workspaceId }),
      resultJson: JSON.stringify({ value: [{ id: flowId, displayName: `Historical flow ${index}`, status: 'ReadyToMigrate' }] }), error: '' });
  }
  await page.goto('/');
  await connect(page);
  await expect(page.getByRole('status', { name: 'Table progress' })).toContainText('Readiness checked');
  await page.getByRole('button', { name: 'Migration history' }).first().click();
  const frame = page.getByRole('region', { name: 'Migration history records' });
  await expect(frame.getByRole('columnheader').nth(0)).toHaveText('Workspace');
  await expect(frame.getByRole('columnheader').nth(1)).toHaveText('Dataflow name');
  await expect(frame.getByRole('columnheader').nth(2)).toHaveText('Request ID');
  const firstRow = frame.getByRole('row').filter({ hasText: 'Historical flow 0' });
  await expect(firstRow.getByRole('cell').nth(0)).toHaveText('Real tenant finance');
  await expect(firstRow.getByRole('cell').nth(2)).toHaveText('00000000-0000-4000-8000-000000000500');
  await expect(frame.getByRole('cell', { name: 'Historical flow 0', exact: true })).toBeVisible();
  const windowScroll = await page.evaluate(() => window.scrollY);
  expect(await frame.evaluate(element => { element.scrollTop = 300; return element.scrollHeight > element.clientHeight && element.scrollTop > 0; })).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(windowScroll);
  await page.getByRole('textbox', { name: 'Search migration history' }).fill('Historical flow 69');
  await expect(frame.getByRole('cell', { name: 'Historical flow 69', exact: true })).toBeVisible();
  await expect(frame.getByRole('cell', { name: 'Historical flow 0', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume tracking' })).toHaveCount(0);
});

for (const count of [2, 80]) {
  test(`history groups ${count} dataflows behind a right-side list panel`, async ({ page }) => {
    const backend = await microsoftBoundary(page);
    const id = '00000000-0000-4000-8000-000000000080';
    const now = new Date().toISOString();
    const items = Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 500).padStart(12, '0')}`,
      displayName: `Batch flow ${index}`, status: 'ReadyToMigrate',
    }));
    backend.records.set(id, { id, ownerId: 'browser-test-user', action: 'assess', workspaceId, workspaceName: 'Real tenant finance',
      status: 'Completed', startedAt: now, completedAt: now, operationUrl: '', targetsJson: '[]',
      requestJson: JSON.stringify({ action: 'assess', requestId: id, workspaceId }),
      resultJson: JSON.stringify({ value: items }), error: '' });
    await page.goto('/');
    await connect(page);
    await expect(page.getByRole('status', { name: 'Table progress' })).toContainText('Readiness checked');
    await page.getByRole('button', { name: 'Migration history' }).first().click();
    const row = page.getByRole('row').filter({ hasText: id });
    const link = row.getByRole('button', { name: 'multiple dataflows...', exact: true });
    await expect(link).toBeVisible();
    await expect(row).not.toContainText('Batch flow 0');
    await link.click();
    const panel = page.getByRole('dialog', { name: 'Dataflows', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('listitem')).toHaveCount(count);
    await expect(panel.getByRole('listitem').first()).toContainText(items[0].displayName);
    await expect(panel.getByRole('listitem').last()).toContainText(items[count - 1].displayName);
    await expect(panel).toContainText(items[count - 1].id);
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds!.x + bounds!.width - page.viewportSize()!.width)).toBeLessThan(2);
    await panel.getByRole('listitem').last().scrollIntoViewIfNeeded();
    await expect(panel.getByRole('listitem').last()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(link).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await link.click();
    await expect(panel).toBeVisible();
    const mobileBounds = await panel.boundingBox();
    expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
    expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(391);
    await panel.getByRole('listitem').last().scrollIntoViewIfNeeded();
    await expect(panel.getByRole('listitem').last()).toBeVisible();
    await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(panel).toHaveCount(0);
  });
}

test('tracking is read-only status, pauses explicitly, and Refresh retries without another upgrade', async ({ page }) => {
  const backend = await microsoftBoundary(page);
  const id = '00000000-0000-4000-8000-000000000090';
  const now = new Date().toISOString();
  const run: LiveRunRecord = { id, ownerId: 'browser-test-user', action: 'upgrade', workspaceId, workspaceName: 'Real tenant finance',
    status: 'Needs reconciliation', startedAt: now, completedAt: '', operationUrl: 'https://api.fabric.microsoft.com/v1/operations/00000000-0000-4000-8000-000000000091', targetsJson: JSON.stringify([flowId]),
    requestJson: JSON.stringify({ action: 'upgrade', requestId: id, workspaceId, ids: [flowId], assessmentId: clientId, acknowledgeInPlace: true, acknowledgeAttention: false }),
    resultJson: JSON.stringify({ targetNames: { [flowId]: 'Actual finance flow' }, verifiedGen2Ids: [] }), error: 'Prior operation unavailable' };
  backend.records.set(id, run);
  let recover = false;
  let polls = 0;
  await page.route('https://backend.example.test/app/**/executeLive/**', async route => {
    if (route.request().method() === 'OPTIONS') { await route.fallback(); return; }
    const execution = executionRequestSchema.parse(JSON.parse(route.request().postDataJSON().request));
    if (execution.action === 'assess') { await route.fallback(); return; }
    expect(execution.action).toBe('poll');
    polls++;
    const record = { ...run, status: recover ? 'Reconciled' : 'Needs reconciliation', error: recover ? '' : 'Microsoft operation and Gen2 readback still unavailable', completedAt: recover ? now : '',
      resultJson: recover ? JSON.stringify({ targetNames: { [flowId]: 'Actual finance flow' }, verifiedGen2Ids: [flowId], reconciliation: {
        method: 'SameIdGen2Readback', operationUrl: run.operationUrl, operationError: '404', checkedAt: now,
        items: [{ id: flowId, displayName: 'Actual finance flow', type: 'Dataflow' }], unverifiedIds: [],
      } }) : run.resultJson };
    backend.records.set(id, record);
    await route.fulfill({ json: { status: 'Succeeded', output: { json: JSON.stringify(record) }, errors: [], invocationId: 'tracking-retry-test' } });
  });
  await page.goto('/');
  await connect(page);
  await expect(page.getByRole('alert')).toContainText('Automatic tracking paused');
  await page.getByRole('button', { name: 'Migration history' }).first().click();
  await expect(page.getByText('Tracking paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume tracking' })).toHaveCount(0);
  expect(polls).toBe(1);
  recover = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Reconciled', exact: true })).toBeVisible();
  expect(polls).toBe(2);
  await expect(page.getByText('Gen2 verified', { exact: true })).toBeVisible();
});

test('connection dialog keeps configuration private and pipeline stage discovery enabled', async ({ page }) => {
  await microsoftBoundary(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect tenant', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('deployment stages');
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('dialog')).not.toContainText(tenantId);
  await expect(page.getByRole('dialog')).not.toContainText(clientId);
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  await expect(page.getByText('1 ready to migrate', { exact: true })).toBeVisible();
  await page.getByLabel('Deployment pipeline stage', { exact: true }).selectOption('Production');
  await page.locator('.workspace-toggle').first().click();
  await expect(page.getByRole('button', { name: 'Actual finance flow Dataflow Gen1' })).toBeVisible();
});

test('soft dark mode persists through sign-in and reload with pinned labeled controls on mobile', async ({ page }, testInfo) => {
  await microsoftBoundary(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await connect(page);
  await expect(page.getByRole('status', { name: 'Table progress' })).toContainText('Readiness checked');
  await expect(page.getByRole('button', { name: 'Disconnect tenant', exact: true })).toHaveText('Disconnect');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('.workspace-toggle').first().click();
  const surfaces = await page.locator('html, .toolbar, .metric, .workbench-card, .workspace-header, .search-box, .filter-bar > select')
    .evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
  for (const color of surfaces) {
    const channels = color.match(/\d+/g)!.slice(0, 3).map(Number);
    expect(Math.max(...channels) - Math.min(...channels), color).toBeLessThanOrEqual(2);
    expect(Math.min(...channels), color).toBeGreaterThan(30);
    expect(Math.max(...channels), color).toBeLessThan(110);
  }
  await page.getByRole('button', { name: 'View Actual finance flow details' }).click();
  const panelColor = await page.locator('.metric').first().evaluate(element => getComputedStyle(element).backgroundColor);
  expect(panelColor).not.toBe('rgb(255, 255, 255)');
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', panelColor);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('soft-dark-desktop.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('status', { name: 'Table progress' })).toContainText('Readiness checked');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.workspace-toggle')).toHaveAttribute('aria-expanded', 'false');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const toolbar = (await page.locator('.toolbar').boundingBox())!;
    expect(toolbar.y).toBe(45);
    for (const button of await page.locator('.toolbar').getByRole('button').all()) {
      await expect(button).toBeInViewport();
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(toolbar.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(toolbar.y + toolbar.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('soft-dark-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toBeVisible();
});

test('delegated sign-in loads real inventory and disconnect returns to blank visuals', async ({ page }) => {
  await microsoftBoundary(page);
  await page.goto('/');
  await expect(page.locator('.metric-number')).toHaveText(['—', '—', '—', '—']);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await connect(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Signed in as tenant-user@example.test')).toBeVisible();
  await page.locator('.workspace-toggle').first().click();
  await expect(page.getByRole('button', { name: 'Actual finance flow Dataflow Gen1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sales orders Dataflow Gen1' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Select Actual finance flow', exact: true })).toBeEnabled();
  await expect(page.getByRole('status', { name: 'Table progress' })).toContainText('Readiness checked');
  await expect(page.getByText('Discovery notes', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Live actions enabled under your Microsoft account.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enable live actions' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('mock-msal-popup-count'))).toBe('1');
  await page.getByLabel('Deployment pipeline stage', { exact: true }).selectOption('Production');
  await expect(page.getByRole('button', { name: 'Assess selected' })).toHaveCount(0);
  await expect(page.getByText('1 ready to migrate', { exact: true })).toBeVisible();
  await page.getByLabel('Migration compatibility status', { exact: true }).selectOption('ReadyToMigrate');
  await expect(page.getByRole('button', { name: 'Actual finance flow Dataflow Gen1' })).toBeVisible();
  await page.getByRole('button', { name: 'View Actual finance flow details' }).click();
  await expect(page.getByRole('dialog')).toContainText(flowId);
  await expect(page.getByRole('dialog')).toContainText('Real finance pipeline');
  await expect(page.getByRole('button', { name: 'Live migration not enabled' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Migration history' }).first().click();
  await expect(page.getByRole('cell', { name: 'API assessment', exact: true })).toHaveCount(1);
  await expect(page.getByRole('cell', { name: 'Sales orders_DFG2' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect tenant', exact: true }).click();
  await expect(page.locator('.metric-number')).toHaveText(['—', '—', '—', '—']);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Migration history' }).first().click();
  await expect(page.getByRole('cell')).toHaveCount(0);
});

test('API permission failure does not display sample inventory as live data', async ({ page }) => {
  await microsoftBoundary(page, true);
  await page.goto('/');
  await connect(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('No sample inventory is substituted');
  await expect(page.getByRole('alert')).toContainText('HTTP 403');
  await expect(page.getByRole('button', { name: 'Sales orders Dataflow Gen1' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Live inventory is not loaded' })).toBeVisible();
});

test('connection and assessment spinners stay beside the progress text in the table', async ({ page }) => {
  await microsoftBoundary(page);
  let releaseConnection!: () => void;
  const connection = new Promise<void>(resolve => { releaseConnection = resolve; });
  let releaseAssessment!: () => void;
  const assessment = new Promise<void>(resolve => { releaseAssessment = resolve; });
  await page.route('https://backend.example.test/app/**/executionKey/**', async route => {
    if (route.request().method() !== 'OPTIONS') await connection;
    await route.fallback();
  });
  await page.route('https://backend.example.test/app/**/executeLive/**', async route => {
    if (route.request().method() !== 'OPTIONS') await assessment;
    await route.fallback();
  });
  try {
    await page.goto('/');
    await connect(page);
    const progress = page.locator('.workbench-card').getByRole('status', { name: 'Table progress' });
    await expect(progress).toHaveText('Connecting live actions...');
    await expect(progress.locator('svg.spin')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connecting live actions...' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry live connection' })).toHaveCount(0);
    releaseConnection();
    await expect(progress).toContainText('Assessing Real tenant finance with Microsoft');
    await expect(progress.locator('svg.spin')).toBeVisible();
    await expect(page.getByText('Discovery notes', { exact: false })).toHaveCount(0);
    await expect(page.getByText('Live actions enabled under your Microsoft account.', { exact: false })).toHaveCount(0);
    releaseAssessment();
    await expect(progress).toHaveText('Readiness checked for 1 of 1 workspaces.');
    await expect(progress.locator('svg.spin')).toHaveCount(0);
  } finally {
    releaseConnection();
    releaseAssessment();
  }
});

test('a failed live connection stays explicit and retries without another Microsoft sign-in', async ({ page }) => {
  await microsoftBoundary(page);
  let unavailable = true;
  await page.route('https://backend.example.test/app/**/executionKey/**', async route => {
    if (!unavailable) { await route.fallback(); return; }
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': request.headers()['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    await route.fulfill({ status: 403, headers, json: { message: 'Test execution backend unavailable' } });
  });
  await page.goto('/');
  await connect(page);
  await expect(page.getByRole('alert')).toContainText('Live actions could not connect');
  await page.locator('.workspace-toggle').first().click();
  await expect(page.getByRole('button', { name: 'Actual finance flow Dataflow Gen1' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select Actual finance flow', exact: true })).toBeDisabled();
  unavailable = false;
  await page.getByRole('button', { name: 'Retry live connection' }).click();
  await expect(page.getByRole('status', { name: 'Table progress' })).toContainText('Readiness checked');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('mock-msal-popup-count'))).toBe('1');
});

test('disconnect is available while the initial inventory scan is still running', async ({ page }) => {
  await microsoftBoundary(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => {
    void page.route('https://api.powerbi.com/v1.0/myorg/groups?**', async route => {
      resolve();
      await pending;
      await route.abort();
    });
  });
  await page.goto('/');
  await connect(page);
  await requested;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Reading your inventory...' })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect tenant', exact: true }).click();
  release!();
  await expect(page.getByRole('button', { name: 'Sales orders Dataflow Gen1' })).toHaveCount(0);
  await expect(page.getByText('Signed in as tenant-user@example.test')).toHaveCount(0);
});

test('real MSAL signs in through a cross-site iframe using one standard OAuth popup without a helper', async ({ page }) => {
  await liveBoundary(page);
  const origin = 'http://127.0.0.1:4179';
  // Keep the cross-site loopback fixture in-process, including popup navigations.
  await page.context().route(`${origin}/**`, async route => route.fulfill({ response: await route.fetch() }));
  const authority = `https://login.microsoftonline.com/${tenantId}`;
  const userId = '00000000-0000-4000-8000-000000000050';
  const clientInfo = Buffer.from(JSON.stringify({ uid: userId, utid: tenantId })).toString('base64url');
  const authorizations: URL[] = [];
  await page.route('http://localhost:4179/embedded-sign-in', route => route.fulfill({ contentType: 'text/html', body:
    `<iframe title="Embedded migration app" src="${origin}" style="width:1400px;height:1050px" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>` }));
  await page.context().route('https://login.microsoftonline.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': request.headers()['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname.endsWith('/discovery/instance')) {
      await route.fulfill({ headers, json: { tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,
        metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net', aliases: ['login.microsoftonline.com', 'login.windows.net', 'sts.windows.net'] }] } }); return;
    }
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      await route.fulfill({ headers, json: {
        issuer: `${authority}/v2.0`, authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
        token_endpoint: `${authority}/oauth2/v2.0/token`, end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
        jwks_uri: `${authority}/discovery/v2.0/keys`,
      } }); return;
    }
    if (url.pathname.endsWith('/authorize')) {
      authorizations.push(url);
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.hash = new URLSearchParams({ code: 'test-authorization-code', state: url.searchParams.get('state')!, client_info: clientInfo }).toString();
      await route.fulfill({ status: 302, headers: { ...headers, Location: callback.href }, body: '' }); return;
    }
    expect(url.pathname).toContain('/token');
    const authorization = authorizations.at(-1)!;
    const scopes = authorization.searchParams.get('scope')!;
    const now = Math.floor(Date.now() / 1000);
    const idToken = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ aud: clientId, iss: `${authority}/v2.0`,
      iat: now, nbf: now, exp: now + 3600, nonce: authorization.searchParams.get('nonce'), tid: tenantId,
      oid: userId, sub: userId, preferred_username: 'tenant-user@example.test', name: 'Tenant user' })).toString('base64url'), 'test-signature'].join('.');
    await route.fulfill({ headers, json: { token_type: 'Bearer', scope: scopes, expires_in: 3600, ext_expires_in: 3600,
      access_token: 'browser-test-execution-token', id_token: idToken, refresh_token: 'test-refresh-token', client_info: clientInfo } });
  });
  await page.route('https://api.powerbi.com/v1.0/myorg/**', async route => {
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    expect(request.headers().authorization).toBe('Bearer browser-test-execution-token');
    const path = new URL(request.url()).pathname;
    const value = path.endsWith('/groups') ? [{ id: workspaceId, name: 'Embedded tenant workspace', isOnDedicatedCapacity: true }]
      : path.endsWith('/dataflows') ? [{ objectId: flowId, name: 'Embedded real-MSAL flow', generation: 1 }] : [];
    await route.fulfill({ headers, json: { value } });
  });
  await page.goto('http://localhost:4179/embedded-sign-in');
  const app = page.frameLocator('iframe');
  const popupOpened = page.waitForEvent('popup');
  let popupCount = 0;
  page.on('popup', () => popupCount++);
  await connect(app);
  const popup = await popupOpened;
  await expect(app.getByText('Signed in as tenant-user@example.test')).toBeVisible({ timeout: 20_000 });
  await expect(app.getByRole('status', { name: 'Table progress' })).toContainText('Readiness checked');
  await app.locator('.workspace-toggle').first().click();
  await expect(app.getByRole('checkbox', { name: 'Select Embedded real-MSAL flow', exact: true })).toBeEnabled();
  expect(authorizations).toHaveLength(1);
  expect(authorizations[0].searchParams.get('scope')).toContain('Dataflow.ReadWrite.All');
  expect(authorizations[0].searchParams.get('scope')).toContain('Item.Execute.All');
  expect(authorizations[0].searchParams.get('pocd')).toBe('1');
  expect(popupCount).toBe(1);
  await expect.poll(() => popup.isClosed()).toBe(true);
});

for (const reconcile of [false, true]) {
test(`native API assessment, reviewed upgrade, and automatic ${reconcile ? '404 reconciliation' : 'completion'} after reload through the real Rayfin SDK and engine`, async ({ page }) => {
      await microsoftBoundary(page);
      const secondId = '00000000-0000-4000-8000-000000000021';
      const remainingId = '00000000-0000-4000-8000-000000000022';
      await page.route(`https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/dataflows*`, route => route.fulfill({
        headers: { 'Access-Control-Allow-Origin': '*' }, json: { value: [
          { objectId: flowId, name: 'Actual finance flow', generation: 1 },
          { objectId: secondId, name: 'Future status flow', generation: 1 },
          { objectId: remainingId, name: 'Remaining ready flow', generation: 1 },
        ] },
      }));
      await page.route('**/rayfin.config.json', route => route.fulfill({ json: { apiUrl: 'https://backend.example.test/app/', publishableKey: 'pk-browser-test' } }));
      const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      const secret = Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
      const key = delegationKey(secret);
      const records = new Map<string, LiveRunRecord>();
      const store: RunStore = {
        async get(id) { return records.has(id) ? structuredClone(records.get(id)!) : null; },
        async insert(run) { records.set(run.id, structuredClone(run)); },
        async save(run) { records.set(run.id, structuredClone(run)); },
      };
      let submissions = 0;
      let operationReady = false;
      let operationPolls = 0;
      const api: MicrosoftApi = async (method, path, body) => {
        const result = (body: unknown, status = 200, location: string | null = null) => ({ body, status, location, retryAfter: null });
        if (path.includes('gen1UpgradeReadinessResults')) return result({ value: [
          { id: flowId, displayName: 'Actual finance flow', status: 'ReadyToMigrate' },
          { id: secondId, displayName: 'Future status flow', status: 'FutureApiVerdict', reasons: [{ code: 'NativeReason', message: 'Unmodified API explanation', status: 'FutureApiVerdict' }] },
          { id: remainingId, displayName: 'Remaining ready flow', status: 'ReadyToMigrate' },
        ] });
        if (method === 'POST') {
          submissions++;
          expect(body).toEqual({ dataflows: [{ id: flowId }] });
          return result(null, 202, 'https://api.fabric.microsoft.com/v1/operations/00000000-0000-4000-8000-000000000030');
        }
        if (path.endsWith('/result')) return result({ migrations: [
          { dataflowId: flowId, dataflowName: 'Actual finance flow', workspaceId, workspaceName: 'Real tenant finance', migrationStatus: 'Succeeded', requiredActions: [{ code: 'Refresh', message: 'Validate the first refresh', status: 'NeedsAttention' }] },
          ...[secondId, remainingId].map(id => ({ dataflowId: id, dataflowName: id === secondId ? 'Future status flow' : 'Remaining ready flow', workspaceId, workspaceName: 'Real tenant finance', migrationStatus: 'Skipped', migrationError: { errorCode: 'NotSelectedForUpgrade', message: 'The dataflow was not selected for upgrade.', isRetriable: false } })),
        ], summary: { totalCount: 1, succeededCount: 1, failedCount: 0 } });
        if (path.includes('/operations/')) {
          operationPolls++;
          if (operationReady && reconcile) throw new MicrosoftApiError(404, 'Microsoft operation HTTP 404');
          return result({ status: operationReady ? 'Succeeded' : 'Running' });
        }
        if (path.endsWith(`/dataflows/${flowId}`)) return result({ id: flowId, displayName: 'Actual finance flow', type: 'Dataflow' });
        return result({ id: workspaceId, displayName: 'Real tenant finance' });
      };
      const accessToken = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ sub: 'browser-test-user', email: 'tenant-user@example.test', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'test-signature'].join('.');
      await page.route('https://backend.example.test/app/**', async route => {
        const request = route.request();
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': request.headers()['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
        if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/brokered/token')) {
          expect(request.headers().authorization).toBe('Bearer browser-test-execution-token');
          await route.fulfill({ headers, json: { accessToken, tokenType: 'Bearer', expiresIn: 3600 } }); return;
        }
        expect(request.headers().authorization).toBe(`Bearer ${accessToken}`);
        let output: { json: string };
        if (path.includes('/executionKey/')) output = { json: JSON.stringify({ jwk: key.jwk }) };
        else if (path.includes('/executionHistory/')) output = { json: JSON.stringify({ records: [...records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), cursor: '' }) };
        else {
          const input = request.postDataJSON() as { request: string; delegation: string };
          expect(request.postData()).not.toContain('browser-test-execution-token');
          expect(await decryptDelegation(input.request, input.delegation, 'browser-test-user', secret)).toBe('browser-test-execution-token');
          const run = await executeRequest(executionRequestSchema.parse(JSON.parse(input.request)), 'browser-test-user', store, api);
          output = { json: JSON.stringify(run) };
        }
        await route.fulfill({ headers, json: { status: 'Succeeded', output, errors: [], invocationId: 'browser-boundary-test' } });
      });

      await page.goto('/');
      await connect(page);
      await expect(page.getByText('Readiness checked for 1 of 1 workspaces.', { exact: true })).toBeVisible();
      await page.locator('.workspace-toggle').first().click();
      await page.getByRole('checkbox', { name: 'Select Actual finance flow', exact: true }).check();
      await expect(page.getByText('Unmodified API explanation', { exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Select Future status flow', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Migrate selected' })).toBeEnabled();
      await page.getByRole('button', { name: 'Migrate selected' }).click();
      await expect(page.getByRole('dialog')).toContainText('not a copy');
      await expect(page.getByRole('button', { name: 'Upgrade in place' })).toBeDisabled();
      await page.getByLabel('I understand this replaces Gen1 in place, rather than creating a copy.').check();
      await page.getByRole('button', { name: 'Upgrade in place' }).click();
      await expect(page.getByText('Tracking automatically', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Resume tracking' })).toHaveCount(0);
      await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'In-place upgrade', exact: true }) }).getByRole('cell').nth(1)).toHaveText('Actual finance flow');
      expect(submissions).toBe(1);
      await page.reload();
      await expect(page.getByRole('status', { name: 'Table progress' })).toContainText('Readiness checked');
      await page.locator('.workspace-toggle').first().click();
      await expect(page.locator('.workspace-lock')).toContainText('Selection is locked by upgrade request');
      await expect(page.getByRole('checkbox', { name: 'Select Remaining ready flow', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => sessionStorage.getItem('mock-msal-popup-count'))).toBe('1');
      await page.getByRole('button', { name: 'Migration history' }).first().click();
      operationReady = true;
      const upgradeRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'In-place upgrade', exact: true }) });
      await expect(upgradeRow.getByRole('cell', { name: reconcile ? 'Reconciled' : 'Completed', exact: true })).toBeVisible({ timeout: 20_000 });
      expect(operationPolls).toBeGreaterThan(0);
      expect(submissions).toBe(1);
      await upgradeRow.getByRole('button', { name: 'View API results' }).click();
      if (reconcile) {
        await expect(page.getByRole('dialog')).toContainText('Gen2 readback reconciliation');
        await expect(page.getByRole('dialog')).toContainText('The original migration result and any required follow-up actions could not be recovered');
        await expect(page.getByRole('dialog')).toContainText('No upgrade was resubmitted');
        await expect(page.getByRole('dialog')).not.toContainText('"apiResult"');
      } else {
        await expect(page.getByRole('dialog')).toContainText('Validate the first refresh');
        await expect(page.getByRole('dialog')).toContainText('NotSelectedForUpgrade');
      }
      await expect(page.getByRole('dialog')).toContainText(flowId);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Migration workbench' }).click();
      await expect(page.locator('.workspace-lock')).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: 'Select Remaining ready flow', exact: true })).toBeEnabled();
      await expect(page.getByRole('checkbox', { name: 'Select workspace Real tenant finance' })).toBeEnabled();
      expect(submissions).toBe(1);
      await page.getByRole('button', { name: 'Disconnect tenant', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sales orders Dataflow Gen1' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Migration history' }).first().click();
      await expect(page.getByText('Real tenant finance', { exact: true })).toHaveCount(0);
});
}
