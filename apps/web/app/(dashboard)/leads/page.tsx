import { Metadata } from 'next';
import { LeadsPageClient } from '@/components/crm/leads-page-client';
import { getLeads } from '@/lib/crm/actions';

export const metadata: Metadata = {
  title: 'Leads',
  description: 'Manage your leads',
};

export const dynamic = 'force-dynamic';

interface LeadsPageProps {
  searchParams: Promise<{
    page?: string;
    status?: string;
    source?: string;
    search?: string;
  }>;
}

export default async function LeadsPage({ searchParams }: LeadsPageProps) {
  const params = await searchParams;
  const data = await getLeads({
    page: params.page ? Number(params.page) : 1,
    status: params.status as never,
    source: params.source as never,
    search: params.search,
  });

  return <LeadsPageClient data={data} />;
}
