import { expect, test } from '@playwright/test';

test('signed-out inventory stays blank and ignores old sample history', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (/graphql|executeLive|api\.powerbi/.test(request.url())) requests.push(request.url()); });
  await page.addInitScript(() => localStorage.setItem('dfg2-migration-studio:audit:v1', 'invalid old demo history'));
  await page.goto('/');
  await expect(page).toHaveTitle('Dataflow Migration Studio | Dataflow Gen2');
  await expect(page.locator('.fabric-brand .subtle')).toHaveText('Dataflow Migration Studio');
  await expect(page.locator('.app-brand strong')).toHaveText('Dataflow Migration Studio');
  await expect(page.locator('.metric-number')).toHaveText(['—', '—', '—', '—']);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Migrate selected' })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Migration history' }).first().click();
  await expect(page.getByRole('cell')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('missing deployment configuration is explicit without editable tenant or application fields', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect tenant', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('not configured for this deployment');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Sign in with Microsoft' })).toBeDisabled();
});

test('mobile signed-out views and the connection dialog fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Migration history', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Live history is not connected' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect tenant', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
