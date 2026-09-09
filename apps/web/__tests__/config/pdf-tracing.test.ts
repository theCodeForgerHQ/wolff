// @vitest-environment node
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

/**
 * @sparticuz/chromium reads its compressed browser from its bin/ folder at
 * runtime, so the build's file tracing never sees it. Without an explicit
 * include, every PDF download on Vercel fails with "The input directory ...
 * @sparticuz/chromium/bin does not exist".
 */
describe('PDF routes ship the Chromium binary', () => {
  it('includes @sparticuz/chromium/bin for the download routes', () => {
    const includes = (nextConfig as { outputFileTracingIncludes?: Record<string, string[]> })
      .outputFileTracingIncludes;
    const globs = includes?.['/api/download/**'] ?? [];
    expect(globs.some((g) => g.includes('@sparticuz/chromium/bin'))).toBe(true);
  });
});
