'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

/** Last-resort boundary for errors thrown by the root layout itself. */
export default function RootLayoutError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        {/* The App Router doesn't expose a status code for render errors. */}
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
