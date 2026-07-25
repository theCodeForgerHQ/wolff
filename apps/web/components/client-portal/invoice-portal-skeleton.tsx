export function InvoicePortalSkeleton() {
  return (
    <div className="flex min-h-screen items-start justify-center bg-gray-100/80 px-4 py-8 sm:py-12 dark:bg-neutral-950">
      <div className="bg-card w-full max-w-[520px] overflow-hidden rounded-2xl border shadow-lg">
        {/* Hero */}
        <div className="px-6 pb-5 pt-8 text-center">
          <div className="bg-muted mx-auto mb-3 h-10 w-10 animate-pulse rounded-full" />
          <div className="bg-muted mx-auto h-4 w-28 animate-pulse rounded" />
          <div className="bg-muted mx-auto mt-2 h-8 w-36 animate-pulse rounded" />
          <div className="bg-muted mx-auto mt-2 h-3 w-44 animate-pulse rounded" />
        </div>

        <div className="border-t border-gray-100" />

        {/* Client + Line Items */}
        <div className="px-6 py-4">
          <div className="mb-4 flex items-center justify-between">
            <div className="space-y-1.5">
              <div className="bg-muted h-4 w-32 animate-pulse rounded" />
              <div className="bg-muted h-3 w-24 animate-pulse rounded" />
            </div>
            <div className="bg-muted h-3 w-10 animate-pulse rounded" />
          </div>

          <div className="border-t border-gray-100 pt-4">
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="space-y-1.5">
                    <div className="bg-muted h-4 w-36 animate-pulse rounded" />
                    <div className="bg-muted h-3 w-48 animate-pulse rounded" />
                  </div>
                  <div className="bg-muted h-4 w-16 animate-pulse rounded" />
                </div>
              ))}
            </div>

            <div className="my-4 border-t border-gray-100" />

            <div className="bg-muted/30 rounded-lg px-3 py-3">
              <div className="flex items-center justify-between">
                <div className="bg-muted h-4 w-16 animate-pulse rounded" />
                <div className="bg-muted h-6 w-24 animate-pulse rounded" />
              </div>
            </div>
          </div>
        </div>

        {/* Button */}
        <div className="px-6 pb-6 pt-2">
          <div className="bg-muted h-12 animate-pulse rounded-lg" />
        </div>

        {/* Footer */}
        <div className="px-6 pb-5">
          <div className="bg-muted mx-auto h-3 w-28 animate-pulse rounded" />
        </div>
      </div>
    </div>
  );
}
