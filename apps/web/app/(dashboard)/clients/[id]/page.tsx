import { notFound } from 'next/navigation';
import { ClientDetail } from '@/components/clients';
import { getClientById, getClientActivity } from '@/lib/clients/actions';
import { getWorkspaceCurrency } from '@/lib/settings/actions';

interface ClientDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

export async function generateMetadata({ params }: ClientDetailPageProps) {
  const { id } = await params;

  if (!UUID_REGEX.test(id)) {
    return { title: 'Client Not Found' };
  }

  try {
    const client = await getClientById(id);
    return {
      title: client.company || client.name,
    };
  } catch {
    return {
      title: 'Client Not Found',
    };
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ClientDetailPage({ params }: ClientDetailPageProps) {
  const { id } = await params;

  if (!UUID_REGEX.test(id)) {
    notFound();
  }

  // Only the data is fetched inside the try: JSX built there would not be
  // covered by it anyway, since React renders it after this function returns.
  let data: Awaited<ReturnType<typeof loadClient>>;
  try {
    data = await loadClient(id);
  } catch {
    notFound();
  }
  const [client, activities, currency] = data;

  return (
    <div className="container py-6">
      <ClientDetail client={client} activities={activities} currency={currency} />
    </div>
  );
}

function loadClient(id: string) {
  return Promise.all([getClientById(id), getClientActivity(id), getWorkspaceCurrency()]);
}
