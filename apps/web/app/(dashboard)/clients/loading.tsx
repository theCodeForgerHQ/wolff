import { CardGridSkeleton } from '@/components/shared';

export default function ClientsLoading() {
  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="bg-muted h-8 w-32 animate-pulse rounded-md" />
        <div className="bg-muted h-10 w-32 animate-pulse rounded-md" />
      </div>
      <CardGridSkeleton cards={6} />
    </div>
  );
}
