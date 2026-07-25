import type { PortalBusinessInfo, PortalClientInfo } from '@/lib/portal/types';

interface PortalFromToProps {
  business: PortalBusinessInfo;
  client: PortalClientInfo;
  fromLabel?: string;
  toLabel?: string;
}

export function PortalFromTo({
  business,
  client,
  fromLabel = 'From',
  toLabel = 'Prepared for',
}: PortalFromToProps) {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {/* From */}
      <div>
        <p className="text-muted-foreground mb-1 text-sm">{fromLabel}</p>
        <div className="space-y-0.5">
          <p className="font-medium">{business.name}</p>
          {business.email && <p className="text-muted-foreground text-sm">{business.email}</p>}
          {business.phone && <p className="text-muted-foreground text-sm">{business.phone}</p>}
          {business.address && (
            <p className="text-muted-foreground whitespace-pre-line text-sm">
              {typeof business.address === 'string'
                ? business.address
                : [
                    business.address.street,
                    business.address.city,
                    business.address.state,
                    business.address.postalCode,
                    business.address.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
            </p>
          )}
        </div>
      </div>

      {/* To */}
      <div>
        <p className="text-muted-foreground mb-1 text-sm">{toLabel}</p>
        <div className="space-y-0.5">
          <p className="font-medium">{client.name}</p>
          {client.company && <p className="text-muted-foreground text-sm">{client.company}</p>}
          {client.email && <p className="text-muted-foreground text-sm">{client.email}</p>}
          {client.address && (
            <p className="text-muted-foreground whitespace-pre-line text-sm">{client.address}</p>
          )}
        </div>
      </div>
    </div>
  );
}
