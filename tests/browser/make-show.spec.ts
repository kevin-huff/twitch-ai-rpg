import { expect, test } from '@playwright/test';

test('the host goes from an idea to a started show on the Make a show page, with two described seats', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('make-a-show')).toBeVisible();
  await page.getByRole('link', { name: 'Make a show', exact: true }).click();
  await expect(page).toHaveURL(/\/make$/);

  // Steps 2 and 3: write a story from an idea, wait for the preview, and use it.
  await page.getByLabel("What's the story?").fill('A lighthouse keeper finds a ledger that lists tomorrow\'s shipwrecks');
  await page.getByRole('button', { name: 'Write my story', exact: true }).click();
  await expect(page.getByTestId('scenario-generator-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Use this story', exact: true }).click();
  await expect(page.getByTestId('show-title')).toBeVisible();
  await expect(page.getByTestId('show-title')).not.toHaveValue('');

  // Step 4: trim the cast to two seats, and describe a character for each in one sentence.
  while (await page.getByTestId('make-seat-remove-2').count()) await page.getByTestId('make-seat-remove-2').click();
  await expect(page.getByTestId('make-seat-kind-0')).toBeVisible();
  await expect(page.getByTestId('make-seat-kind-1')).toBeVisible();
  await expect(page.getByTestId('make-seat-kind-2')).toHaveCount(0);
  const sentences = ['A clever archivist who hides a debt', 'A charming singer who owes a favour'];
  for (const [index, sentence] of sentences.entries()) {
    await page.getByTestId(`make-seat-kind-${index}`).selectOption({ label: 'Describe a character' });
    await page.getByTestId(`make-seat-describe-${index}`).fill(sentence);
  }

  // Steps 5 and 6: creating the show writes both cards, then lands on Cast & lobby with every seat holding a card.
  await page.getByTestId('create-show').click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/lobby/, { timeout: 30_000 });
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 2 of 2');

  // Step 7: start the show.
  await expect(page.getByTestId('start-session')).toBeEnabled();
  await page.getByTestId('start-session').click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/director/);
  await expect(page.getByTestId('director-controls')).toBeVisible();
  await page.getByRole('link', { name: 'Cast & lobby' }).click();
  await expect(page.getByTestId('back-to-show')).toHaveText('Back to the show');
});
