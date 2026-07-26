import { Skeleton } from '@/components/ui/skeleton';

export default function EditClientLoading() {
  return (
    <div className="max-w-2xl space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
