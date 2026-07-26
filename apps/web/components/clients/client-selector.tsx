'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Check, ChevronsUpDown, User, Building2, Plus, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { searchClients } from '@/lib/clients/actions';
import Link from 'next/link';

interface ClientOption {
  id: string;
  name: string;
  email: string;
  company: string | null;
}

interface ClientSelectorProps {
  value: ClientOption | null;
  onChange: (client: ClientOption | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ClientSelector({
  value,
  onChange,
  placeholder = 'Search clients...',
  disabled = false,
}: ClientSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Debounced search function
  const handleSearch = useCallback(async (query: string) => {
    if (query.length < 1) {
      setClients([]);
      return;
    }

    setIsLoading(true);
    try {
      const results = await searchClients(query, 10);
      setClients(results);
    } catch {
      toast.error('Failed to search clients');
      setClients([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Debounce search input
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      handleSearch(search);
    }, 200);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [search, handleSearch]);

  // Focus input when popover opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const handleSelect = (client: ClientOption) => {
    onChange(client);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          disabled={disabled}
        >
          {value ? (
            <div className="flex items-center gap-2 truncate">
              <div className="bg-primary/10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                {value.company ? (
                  <Building2 className="text-primary h-3 w-3" />
                ) : (
                  <User className="text-primary h-3 w-3" />
                )}
              </div>
              <span className="truncate">{value.company || value.name}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <div className="flex flex-col">
          {/* Search Input */}
          <div className="flex items-center border-b px-3 py-2">
            <Input
              ref={inputRef}
              placeholder="Type to search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 border-0 px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {isLoading && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
          </div>

          {/* Results */}
          <div className="max-h-[200px] overflow-y-auto">
            {clients.length === 0 && !isLoading && search.length > 0 && (
              <div className="text-muted-foreground py-6 text-center text-sm">No clients found</div>
            )}

            {clients.length === 0 && search.length === 0 && (
              <div className="text-muted-foreground py-6 text-center text-sm">
                Start typing to search clients
              </div>
            )}

            {clients.map((client) => (
              <button
                key={client.id}
                onClick={() => handleSelect(client)}
                className={cn(
                  'hover:bg-accent flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                  value?.id === client.id && 'bg-accent'
                )}
              >
                <div className="bg-primary/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
                  {client.company ? (
                    <Building2 className="text-primary h-4 w-4" />
                  ) : (
                    <User className="text-primary h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{client.company || client.name}</p>
                  <p className="text-muted-foreground truncate text-xs">{client.email}</p>
                </div>
                {value?.id === client.id && <Check className="text-primary h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>

          {/* Add New Client Link */}
          <div className="border-t p-2">
            <Link
              href="/clients/new"
              className="text-primary hover:bg-accent flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add new client
            </Link>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
