import { test, expect } from '@playwright/test';
import { prisma } from '@wolff/database';

test.describe('Automation approval inbox', () => {
  const runIds: string[] = [];
  const automationIds: string[] = [];

  test.afterEach(async () => {
    await prisma.automationRun.deleteMany({
      where: { automationId: { in: automationIds } },
    });
    await prisma.automation.deleteMany({
      where: { OR: [{ id: { in: automationIds } }, { name: { startsWith: 'E2E Approval ' } }] },
    });
    runIds.length = 0;
    automationIds.length = 0;
  });

  test('pauses at approval and resumes on approve', async ({ page }) => {
    const run = Date.now();
    const name = `E2E Approval ${run}`;

    // Create the automation via the UI so it lives in the active workspace.
    await page.goto('/automations');
    await page.getByRole('button', { name: 'New automation' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Invoice overdue' }).click();
    await dialog.getByRole('button', { name: 'Approval' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible();

    const automation = await prisma.automation.findFirstOrThrow({
      where: { name },
      select: { id: true, workspaceId: true },
    });
    automationIds.push(automation.id);

    // Seed a run that is paused at the approval step.
    const automationRun = await prisma.automationRun.create({
      data: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        subjectId: 'e2e-subject-approval',
        status: 'waiting_approval',
        currentStep: 0,
        waitingSince: new Date(),
      },
    });
    runIds.push(automationRun.id);

    await page.reload();
    await page.getByRole('tab', { name: /Approvals/i }).click();

    const waitingText = page.getByText(/Waiting for approval at step 1/i);
    await expect(waitingText).toBeVisible();

    await page.getByRole('button', { name: /Approve/i }).click();

    await expect(waitingText).not.toBeVisible();

    const updated = await prisma.automationRun.findUniqueOrThrow({
      where: { id: automationRun.id },
    });
    expect(updated.status).toBe('running');
    expect(updated.currentStep).toBe(1);
  });
});
