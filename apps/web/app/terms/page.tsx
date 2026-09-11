import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Terms of Service</h1>
      <p className="text-muted-foreground mt-2 text-sm">Last updated September 4, 2026</p>

      <div className="mt-8 space-y-6 leading-7">
        <p>
          This is a demo of Wolff, an open-source quote-to-cash app. It is here so you can try it
          out, not to run a real business on.
        </p>
        <section>
          <h2 className="text-xl font-semibold">Using the demo</h2>
          <p className="mt-2">
            You can create clients, quotes, invoices and contracts and see how they flow. Demo data
            resets every day, so anything you add may be deleted without notice. Payments run in
            test mode and no real money moves.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">Fair use</h2>
          <p className="mt-2">
            Please don&apos;t use it to send spam, store other people&apos;s personal data without
            their consent, or try to break into accounts that aren&apos;t yours. We may remove
            accounts that do.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">No warranty</h2>
          <p className="mt-2">
            The demo is provided as is. It may be slow, change, or go offline at any time, and we
            aren&apos;t liable for any loss that comes from using it.
          </p>
        </section>
        <p>
          See also our{' '}
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
