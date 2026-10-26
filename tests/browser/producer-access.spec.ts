import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('a producer signs in from a link, runs a rehearsal, and loses access the moment the host revokes it', async ({ page, browser }) => {
  const name = `Dana ${randomUUID().slice(0, 6)}`;
  const title = `Producer rehearsal ${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByLabel('Session title').fill(title);
  await page.getByRole('button', { name: 'Create rehearsal session' }).click();
  await expect(page.getByRole('link', { name: 'Enter director workspace' })).toBeVisible();
  await page.getByRole('link', { name: 'Enter director workspace' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  await page.goto(page.url().split('/sessions/')[0] + '/' + (new URL(page.url()).search));

  const access = page.getByRole('region', { name: 'Producer access' });
  await access.getByLabel('Producer name').fill(name);
  await access.getByRole('button', { name: 'Create producer link' }).click();
  const link = await access.getByLabel(`Producer link for ${name}`).inputValue();
  expect(new URL(link).pathname).toBe('/producer');
  expect(new URL(link).hash).toMatch(/^#token=.+/);

  const producerContext = await browser.newContext();
  try {
    const producer = await producerContext.newPage();
    await producer.goto(link);
    await producer.getByRole('button', { name: 'Sign in as producer' }).click();
    await expect(producer.getByText(`Producer · ${name}`)).toBeVisible();
    await producer.getByRole('link', { name: `${title} →` }).click();
    await expect(producer.getByTestId('director-controls')).toBeVisible();
    await expect(producer.getByText(`Producer · ${name}`)).toBeVisible();
    await producer.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await expect(producer.getByRole('heading', { name: 'Collecting input' })).toBeVisible();

    const row = access.getByRole('listitem').filter({ hasText: name });
    await expect(row).toContainText('Active');
    await row.getByRole('button', { name: 'Revoke', exact: true }).click();
    await row.getByRole('button', { name: 'Revoke access' }).click();
    await expect(row.getByRole('button', { name: 'Revoke access' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Show link' })).toHaveCount(0);

    await producer.getByRole('button', { name: 'Pause table' }).click();
    const notice = producer.getByRole('alert');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/sign in|signed in|sign-in|revoked|expired/i);
  } finally { await producerContext.close(); }
});
