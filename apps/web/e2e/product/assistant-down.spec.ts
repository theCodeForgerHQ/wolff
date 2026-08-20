import { expect, test } from '@playwright/test';

/**
 * Phase 5 DoD: with the AI service stopped, reports and the core
 * flow still work. This config points AI_URL at a closed port, so the AI
 * service is configured but down for every spec in the run (lead to paid
 * included); this spec checks the app hides the assistant and the report
 * pages render.
 */
test.describe('with the AI service down', () => {
  test('the assistant is hidden and reports still load', async ({ page, request }) => {
    const status = await request.get('/api/assistant/status');
    expect(await status.json()).toEqual({ available: false });

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The launcher asks for the status once on mount; give it a moment.
    await page.waitForResponse((r) => r.url().endsWith('/api/assistant/status'));
    await expect(page.getByRole('button', { name: 'Open the assistant' })).toHaveCount(0);

    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    const chat = await request.post('/api/assistant/chat', { data: { message: 'hi' } });
    expect(chat.status()).toBe(502);
  });
});
