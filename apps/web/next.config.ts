import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

// The browser SDK posts events to the DSN's host; allow it only when Sentry is on.
const sentryOrigin = process.env.NEXT_PUBLIC_SENTRY_DSN
  ? new URL(process.env.NEXT_PUBLIC_SENTRY_DSN).origin
  : null;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Bug #20: Enable standalone output for Docker production builds
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  transpilePackages: ['@wolff/ui', '@wolff/utils', '@wolff/types', '@wolff/core'],
  // Bug #23: Prevent access token leakage via referrer headers on portal pages
  async headers() {
    // Bug #5: Security headers for all routes (mirrors vercel.json for Docker/self-hosted deployments)
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-XSS-Protection', value: '1; mode=block' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=(), usb=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
      {
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://js.stripe.com",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "img-src 'self' data: blob: https:",
          "font-src 'self' https://fonts.gstatic.com",
          'frame-src https://js.stripe.com',
          `connect-src 'self' https://api.stripe.com${sentryOrigin ? ` ${sentryOrigin}` : ''}`,
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      },
    ];

    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
      {
        source: '/q/:token*',
        headers: [...securityHeaders, { key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/i/:token*',
        headers: [...securityHeaders, { key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/c/:token*',
        headers: [...securityHeaders, { key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
    ],
  },
  serverExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
    // Bug #196: Next.js API routes default to 1mb body size limit.
    // This is sufficient for our use case (JSON payloads for quotes/invoices).
    // Server actions have a higher limit (10mb) for file uploads.
  },
};

// Source maps are only uploaded when SENTRY_AUTH_TOKEN (plus org/project) is
// set, e.g. in a release pipeline; without it the build makes no Sentry calls.
export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  silent: !process.env.CI,
  telemetry: false,
});
