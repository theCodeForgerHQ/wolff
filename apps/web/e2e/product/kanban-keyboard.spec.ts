import { expect, test } from '@playwright/test';
import { prisma } from '@wolff/database';
import { untilKeyboardSensorListens } from './dnd-keyboard';

/**
 * Deals can be moved between stages with the
 * keyboard alone (dnd-kit KeyboardSensor), with announcements for screen
 * readers.
 */
test.describe('Pipeline Kanban keyboard moves', () => {
  test.afterAll(async () => {
    await prisma.deal.deleteMany({ where: { title: { startsWith: 'E2E Keyboard ' } } });
    await prisma.$disconnect();
  });

  test('moves a deal to the next stage with Space, ArrowRight, Space', async ({ page }) => {
    const title = `E2E Keyboard ${Date.now()}`;
    await page.goto('/deals');

    // Put a deal in the first stage through the UI's own data (the demo
    // workspace's default pipeline).
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'demo@wolff.demo' } });
    const member = await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } });
    const pipeline = await prisma.pipeline.findFirstOrThrow({
      where: { workspaceId: member.workspaceId, isDefault: true },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    const [first, second] = pipeline.stages;
    await prisma.deal.create({
      data: {
        workspaceId: member.workspaceId,
        pipelineId: pipeline.id,
        stageId: first!.id,
        title,
        value: 1000,
      },
    });
    await page.reload();

    const handle = page.getByRole('button', { name: `Move ${title} to another stage` });
    // What dnd-kit tells screen readers, through its live region.
    const announced = page.locator('[id^="DndLiveRegion"]').first();
    await handle.focus();
    await page.keyboard.press('Space');
    await expect(announced).toContainText(`${title} is over ${first!.name}`);
    await untilKeyboardSensorListens(page);
    await page.keyboard.press('ArrowRight');
    await expect(announced).toContainText(`${title} is over ${second!.name}`);
    await page.keyboard.press('Space');
    await expect(announced).toContainText(`${title} dropped in ${second!.name}`);

    await expect(page.getByText('Deal moved')).toBeVisible();
    await expect
      .poll(async () => (await prisma.deal.findFirst({ where: { title } }))?.stageId)
      .toBe(second!.id);
  });
});
