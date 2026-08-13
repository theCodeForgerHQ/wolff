import { test, expect } from '@playwright/test';

/**
 * The widget is interactive within 300 ms of DOMContentLoaded on a
 * throttled "Fast 3G / 4x CPU" profile. "Interactive" is the widget's own
 * performance mark, set once the form and its handlers are mounted.
 */
test.describe('Widget performance', () => {
  test('lead form is interactive within 300 ms of DOMContentLoaded (Fast 3G, 4x CPU)', async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    // Chrome DevTools' "Fast 3G" preset.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 562.5,
      downloadThroughput: (1.44 * 1024 * 1024) / 8,
      uploadThroughput: (675 * 1024) / 8,
    });

    await page.goto('/');
    await page.locator('[data-wolff-widget="lead-form"] input').first().waitFor();

    const timing = await page.evaluate(() => {
      const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      const [mark] = performance.getEntriesByName('wolff-widget:interactive');
      return { domContentLoaded: nav!.domContentLoadedEventEnd, interactive: mark?.startTime };
    });

    expect(timing.interactive, 'widget never marked itself interactive').toBeDefined();
    const sinceDcl = timing.interactive! - timing.domContentLoaded;
    test.info().annotations.push({ type: 'interactive-ms', description: sinceDcl.toFixed(1) });
    expect(sinceDcl).toBeLessThanOrEqual(300);
  });
});
