import { notFound, redirect } from 'next/navigation';
import { getQuote } from '@/lib/quotes/actions';
import EditQuoteForm from './edit-quote-form';
import { isRecordId } from '@/lib/validations/record-id';

export const metadata = {
  title: 'Edit Quote',
};

interface EditQuotePageProps {
  params: Promise<{ id: string }>;
}

export default async function EditQuotePage({ params }: EditQuotePageProps) {
  const { id } = await params;

  if (!isRecordId(id)) {
    notFound();
  }

  const quote = await getQuote(id);

  if (!quote) {
    notFound();
  }

  // Only draft quotes can be edited
  if (quote.status !== 'draft') {
    redirect(`/quotes/${id}`);
  }

  return <EditQuoteForm quote={quote} />;
}
