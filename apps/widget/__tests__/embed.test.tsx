import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { init, destroy } from '../src/embed';

describe('embed', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div data-wolff-widget="lead-form"></div>';
  });

  afterEach(() => {
    destroy();
    document.body.innerHTML = '';
  });

  it('mounts a widget into a matching target', () => {
    init({ publishableKey: 'wolff_pk_test', apiBaseUrl: 'https://api.example.com' });
    const target = document.querySelector('[data-wolff-widget="lead-form"]') as HTMLElement;
    expect(target.shadowRoot).not.toBeNull();
    expect(target.shadowRoot!.querySelector('.ow-widget')).not.toBeNull();
  });

  it('creates isolated shadow roots per target', () => {
    document.body.innerHTML =
      '<div data-wolff-widget="lead-form" id="a"></div><div data-wolff-widget="lead-form" id="b"></div>';
    init({ publishableKey: 'wolff_pk_test', apiBaseUrl: 'https://api.example.com' });
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    expect(a.shadowRoot).not.toBe(b.shadowRoot);
  });
});
