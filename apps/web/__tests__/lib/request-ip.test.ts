import { describe, expect, it } from 'vitest';
import { requestIp } from '@/lib/request-ip';

const h = (entries: Record<string, string>) => new Headers(entries);

describe('requestIp', () => {
  // Rate limits key on this. The leftmost X-Forwarded-For entry is whatever
  // the client sent, so a new value per request would get a new count.
  it('ignores the entries a client put in front of X-Forwarded-For', () => {
    expect(requestIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('prefers x-real-ip, which the edge (Vercel, nginx) sets itself', () => {
    expect(requestIp(h({ 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '1.2.3.4' }))).toBe(
      '198.51.100.9'
    );
  });

  it('takes a single forwarded address as is', () => {
    expect(requestIp(h({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('is null when there is nothing to go on', () => {
    expect(requestIp(h({}))).toBeNull();
    expect(requestIp(h({ 'x-forwarded-for': ' , ' }))).toBeNull();
  });
});
