import { describe, it, expect, vi } from 'vitest';
import {
  buildCorsHeaders,
  validateSearchQuery,
  validateCourseId,
  authenticateRequest
} from '../edge-functions/search-golf-course/search-golf-course.ts';

describe('course edge function security', () => {
  it('allows only configured origins', () => {
    const allowed = buildCorsHeaders('https://app.example.com');
    expect(allowed['Access-Control-Allow-Origin']).toBe('https://app.example.com');

    const blocked = buildCorsHeaders('https://evil.example.com');
    expect(blocked['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('rejects invalid search queries', () => {
    expect(validateSearchQuery('')).toBeNull();
    expect(validateSearchQuery('A')).toBeNull();
    expect(validateSearchQuery('Pebble Beach')).toBe('Pebble Beach');
    expect(validateSearchQuery('x'.repeat(200))).toBeNull();
  });

  it('rejects invalid course ids', () => {
    expect(validateCourseId('')).toBeNull();
    expect(validateCourseId('pmyjyz8s')).toBe('pmyjyz8s');
    expect(validateCourseId('abc/def')).toBeNull();
    expect(validateCourseId('123')).toBe('123');
    expect(validateCourseId(456)).toBe(456);
    expect(validateCourseId('12345678901')).toBe('12345678901');
  });

  it('rejects missing or invalid bearer tokens', async () => {
    const noToken = await authenticateRequest(
      new Request('https://example.com', { method: 'POST' }),
      'https://project.supabase.co',
      'anon-key'
    );
    expect(noToken.ok).toBe(false);
    expect(noToken.status).toBe(401);

    const badToken = await authenticateRequest(
      new Request('https://example.com', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid-token' }
      }),
      'https://project.supabase.co',
      'anon-key'
    );
    expect(badToken.ok).toBe(false);
    expect(badToken.status).toBe(401);
  });

  it('accepts a verified Supabase user from the Authorization header', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'user-123' })
    }));

    const auth = await authenticateRequest(
      new Request('https://example.com', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token' }
      }),
      'https://project.supabase.co',
      'anon-key'
    );

    expect(auth.ok).toBe(true);
    expect(auth.userId).toBe('user-123');
  });
});
