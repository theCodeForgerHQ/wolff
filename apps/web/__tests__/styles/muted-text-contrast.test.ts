// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `text-muted-foreground` measures 4.55:1 on the card background, just above
 * the WCAG AA minimum of 4.5:1 for body text, so any opacity modifier on it
 * fails: /70 is 2.66:1, /60 is 2.25:1 and /50 is 1.93:1 (measured in Chromium
 * on the portal and dashboard).
 *
 * Tailwind 3 could not apply an opacity modifier to the theme's var() colours
 * and silently dropped these classes; Tailwind 4 renders them with
 * color-mix(), which is how 53 of them went from invisible to too faint.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE_DIRS = ['app', 'components'];
const FADED_MUTED_TEXT = /text-muted-foreground\/\d+/g;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx|ts|css)$/.test(entry.name) ? [full] : [];
  });
}

describe('muted text contrast', () => {
  it('never fades text-muted-foreground below WCAG AA with an opacity modifier', () => {
    const offenders = SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir))).flatMap(
      (file) => {
        const matches = fs.readFileSync(file, 'utf8').match(FADED_MUTED_TEXT) ?? [];
        return matches.length ? [`${path.relative(ROOT, file)}: ${matches.length}`] : [];
      }
    );

    expect(offenders).toEqual([]);
  });
});
