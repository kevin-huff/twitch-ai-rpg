import { expect, test, type Locator, type Page } from '@playwright/test';

async function expectNoticeInView(page: Page, alert: Locator, save: Locator, saveY: number) {
  await expect(alert).toBeVisible();
  const bounds = (await alert.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  expect(Math.abs((await save.boundingBox())!.y - saveY)).toBeLessThan(2);
  expect(await save.evaluate(button => {
    const box = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
}

for (const width of [1280, 390]) {
  test(`keeps save errors visible without losing edits or scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/');
    await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
    await page.getByRole('button', { name: 'Sign in as host' }).click();
    await page.getByTestId('library-link').click();
    await page.getByRole('button', { name: 'Use rehearsal scenario', exact: true }).click();
    const title = page.getByLabel('Scenario title', { exact: true });
    await expect(title).not.toHaveValue('New scenario');
    const titleBefore = await title.inputValue();
    await title.fill('');
    const notes = page.getByLabel('Director notes', { exact: true });
    await notes.fill('Keep these unsaved notes after a failed save.');
    const save = page.getByTestId('save-scenario');
    await save.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    const firstSaveY = (await save.boundingBox())!.y;
    await save.click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Please enter valid content');
    await expectNoticeInView(page, alert, save, firstSaveY);
    await expect(alert.locator(':focus')).toHaveCount(0);
    await expect(notes).toHaveValue('Keep these unsaved notes after a failed save.');
    await page.getByRole('button', { name: 'Dismiss error' }).focus();
    await page.keyboard.press('Enter');
    await expect(alert).toHaveCount(0);
    await save.click();
    await expect(alert).toContainText('Please enter valid content');
    await page.getByRole('button', { name: 'Dismiss error' }).click();

    await title.fill(titleBefore);
    const serverMessage = `Could not save this version. Keep your edits and try again. ${'Details '.repeat(180)}${'x'.repeat(180)}`;
    await page.route('**/api/library/scenarios', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: serverMessage }) }));
    await save.scrollIntoViewIfNeeded();
    const secondSaveY = (await save.boundingBox())!.y;
    await save.click();
    await expect(alert).toContainText('Could not save this version');
    await expectNoticeInView(page, alert, save, secondSaveY);
    await expect(notes).toHaveValue('Keep these unsaved notes after a failed save.');
    await expect(page.getByRole('button', { name: 'Dismiss error' })).toBeInViewport();
    await page.screenshot({ path: `test-results/save-error-${width}.png` });
    await page.getByRole('button', { name: 'Dismiss error' }).click();
    await page.unroute('**/api/library/scenarios');
    await save.click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Scenario saved as version');
  });
}
