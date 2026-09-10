import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Privacy Policy</h1>
      <p className="text-muted-foreground mt-2 text-sm">Last updated September 4, 2026</p>

      <div className="mt-8 space-y-6 leading-7">
        <p>This page explains what the Wolff demo keeps about you and why.</p>
        <section>
          <h2 className="text-xl font-semibold">What we store</h2>
          <p className="mt-2">
            Your name, email address and a hashed password, plus whatever you enter into the app:
            business details, clients, quotes, invoices, contracts and signatures. We also keep
            basic logs, such as IP addresses and error reports, to keep the service running and
            secure.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">Who else handles it</h2>
          <p className="mt-2">
            The app runs on Vercel, with its database on Neon and files on Supabase. Emails are sent
            through Resend, card payments go through Stripe in test mode, and errors are reported to
            Sentry. The AI assistant sends your question and the relevant documents to NVIDIA or
            Groq to write an answer.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">How long we keep it</h2>
          <p className="mt-2">
            Demo data resets daily. You can also delete your workspace at any time under Settings,
            Workspace, which removes it and everything in it.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">What we don&apos;t do</h2>
          <p className="mt-2">We don&apos;t sell your data or use it for advertising.</p>
        </section>
        <p>
          See also our{' '}
          <Link href="/terms" className="underline underline-offset-4">
            Terms of Service
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
