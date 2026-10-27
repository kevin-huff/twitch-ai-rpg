import { expect, test, type Page } from '@playwright/test';

test.setTimeout(90000);

async function practiceShow(page: Page) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/director/);
  await expect(page.getByTestId('director-controls')).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2]!;
}

test('Help Back returns a Test as player to the seat address, identity included, under the no-referrer policy', async ({ page, context }) => {
  await practiceShow(page);
  await page.getByRole('link', { name: 'Cast & lobby' }).click();
  const popup = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Test as Rook ↗', exact: true }).click();
  const player = await popup;
  await expect(player.getByRole('heading', { name: 'Rook', exact: true })).toBeVisible();
  const seatUrl = new URL(player.url());
  expect(seatUrl.pathname).toMatch(/^\/sessions\/[^/]+\/play$/);
  expect(seatUrl.searchParams.get('identity')).toBeTruthy();

  await player.locator('.header-meta').getByRole('link', { name: 'Help', exact: true }).click();
  await expect(player).toHaveURL(/\/help/);
  await player.getByTestId('help-back').click();
  await expect(player).toHaveURL(seatUrl.toString());
  await expect(player.getByRole('heading', { name: 'Rook', exact: true })).toBeVisible();
  await expect(player.getByLabel('Host access token')).toHaveCount(0);
  await expect(player.getByText('Host access token')).toHaveCount(0);
});

test('Help Back returns a director to the director page after following a Contents link', async ({ page }) => {
  const sessionId = await practiceShow(page);
  await page.locator('.header-meta').getByRole('link', { name: 'Help', exact: true }).click();
  await expect(page).toHaveURL(/\/help/);
  await page.getByRole('navigation', { name: 'Help contents' }).getByRole('link', { name: 'Running a show', exact: true }).click();
  await expect(page).toHaveURL(/#running-a-show$/);
  await page.getByTestId('help-back').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}/director`));
  await expect(page.getByTestId('director-controls')).toBeVisible();
});
