import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('a producer signs in from a link, runs a rehearsal, and loses access the moment the host revokes it', async ({ page, browser }) => {
  const name = `Dana ${randomUUID().slice(0, 6)}`;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2];
  await page.goto(page.url().split('/sessions/')[0] + '/' + (new URL(page.url()).search));

  await page.getByTestId('home-more').locator(':scope > summary').click();
  const access = page.getByRole('region', { name: 'Producer access' });
  await access.getByLabel('Producer name').fill(name);
  await access.getByRole('button', { name: 'Create producer link' }).click();
  await expect(access.getByTestId('producer-copied')).toHaveText('Copied. Send it privately. It signs them in.');
  const link = await access.getByLabel(`Producer link for ${name}`).inputValue();
  expect(new URL(link).pathname).toBe('/producer');
  expect(new URL(link).hash).toMatch(/^#token=.+/);

  const listed = await page.request.get('/api/sessions');
  expect(listed.ok()).toBe(true);
  const shows = (await listed.json()) as Array<{ id: string }>;
  expect(shows.map(show => show.id)).toContain(sessionId);

  const producerContext = await browser.newContext();
  try {
    const producer = await producerContext.newPage();
    await producer.goto(link);
    await producer.getByRole('button', { name: 'Sign in as producer' }).click();
    await expect(producer.getByText(`Producer · ${name}`)).toBeVisible();
    if (shows.length === 1) {
      // One show: sign-in lands straight on its director page, with no list in between.
      await expect(producer.getByTestId('director-controls')).toBeVisible();
      await expect(producer.getByTestId('shows-you-can-run')).toHaveCount(0);
      expect(new URL(producer.url()).pathname).toBe(`/sessions/${sessionId}/director`);
    } else {
      // Several shows: Shows you can run lists each one with its own Open the director page link.
      await expect(producer.getByTestId('shows-you-can-run')).toBeVisible();
      await expect(producer.locator('[data-testid^="open-director-"]')).toHaveCount(shows.length);
      for (const show of shows) await expect(producer.getByTestId(`open-director-${show.id}`)).toBeVisible();
      await expect(producer.getByTestId('director-controls')).toHaveCount(0);
      await producer.getByTestId(`open-director-${sessionId}`).click();
      await expect(producer.getByTestId('director-controls')).toBeVisible();
    }
    await expect(producer.getByText(`Producer · ${name}`)).toBeVisible();
    await producer.getByTestId('beat-more').locator(':scope > summary').click();
    await producer.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await expect(producer.getByRole('heading', { name: 'Collecting input' })).toBeVisible();

    const row = access.getByRole('listitem').filter({ hasText: name });
    await expect(row).toContainText('Active');
    await row.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(row).toContainText(`Turn off ${name}'s access?`);
    await row.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(row).toContainText('Turned off');
    await expect(row.getByRole('button', { name: 'Keep access' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Show link' })).toHaveCount(0);

    await producer.getByTestId('top-pause').click();
    const notice = producer.getByRole('alert');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/sign in|signed in|sign-in|revoked|expired/i);
  } finally { await producerContext.close(); }
});
