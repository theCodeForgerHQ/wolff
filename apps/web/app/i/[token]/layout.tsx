import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'View Invoice',
  description: 'View and pay your invoice',
  robots: {
    index: false,
    follow: false,
  },
};

export default function InvoicePortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="bg-linear-to-b from-muted/30 to-background min-h-screen">{children}</div>;
}
