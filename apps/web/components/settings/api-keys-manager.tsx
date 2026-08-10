'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Key, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { generateApiKey, revokeApiKey } from '@/lib/api-keys/actions';
import type { ApiKeyListItem } from '@/lib/api-keys/actions';
import { formatDate } from '@/lib/utils';

interface ApiKeysManagerProps {
  keys: ApiKeyListItem[];
}

export function ApiKeysManager({ keys }: ApiKeysManagerProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyKind, setKeyKind] = useState<'secret' | 'publishable'>('secret');
  const [origins, setOrigins] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const handleCreate = async () => {
    if (!keyName.trim()) {
      toast.error('Please enter a name for the key');
      return;
    }
    setIsCreating(true);
    try {
      const result = await generateApiKey({
        name: keyName,
        kind: keyKind,
        allowedOrigins:
          keyKind === 'publishable' ? origins.split(/[\s,]+/).filter(Boolean) : undefined,
      });
      if (!result.success) {
        toast.error(result.error || 'Failed to create API key');
        return;
      }
      setNewKey(result.key!);
      setKeyName('');
      setOrigins('');
      router.refresh();
    } catch {
      toast.error('Failed to create API key');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      toast.success('API key copied to clipboard');
    }
  };

  const handleCloseNewKey = () => {
    setNewKey(null);
    setCreateOpen(false);
  };

  const handleRevoke = async () => {
    if (!revokeId) return;
    setIsRevoking(true);
    try {
      const result = await revokeApiKey(revokeId);
      if (!result.success) {
        toast.error(result.error || 'Failed to revoke key');
        return;
      }
      toast.success('API key revoked');
      setRevokeId(null);
      router.refresh();
    } catch {
      toast.error('Failed to revoke key');
    } finally {
      setIsRevoking(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>API Keys</CardTitle>
            <CardDescription>
              Use API keys to authenticate requests to the Wolff REST API.
            </CardDescription>
          </div>
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Create Key
          </Button>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Key className="text-muted-foreground mb-3 h-10 w-10" />
              <p className="text-muted-foreground text-sm">
                No API keys yet. Create one to start using the API.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {keys.map((key) => (
                <div
                  key={key.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {key.name}
                      {key.kind === 'publishable' && (
                        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-normal">
                          Widget
                        </span>
                      )}
                    </p>
                    {key.kind === 'publishable' && (
                      <p className="text-muted-foreground text-xs">
                        Allowed from {key.allowedOrigins.join(', ')}
                      </p>
                    )}
                    <div className="text-muted-foreground flex items-center gap-3 text-xs">
                      <span className="font-mono">{key.keyPrefix}...••••••</span>
                      <span>Created {formatDate(key.createdAt)}</span>
                      {key.lastUsedAt && <span>Last used {formatDate(key.lastUsedAt)}</span>}
                      {key.expiresAt && <span>Expires {formatDate(key.expiresAt)}</span>}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setRevokeId(key.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Key Dialog */}
      <Dialog open={createOpen && !newKey} onOpenChange={(open) => !open && setCreateOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
            <DialogDescription>
              Give your key a name so you can identify it later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label htmlFor="key-name">Key Name</Label>
              <Input
                id="key-name"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="e.g. Zapier Integration"
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Kind</legend>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['secret', 'Secret key', 'Server-side REST API access'],
                    ['publishable', 'Widget key', 'Lead form and invoice payment, from your site'],
                  ] as const
                ).map(([value, title, hint]) => (
                  <label
                    key={value}
                    className="has-[:checked]:border-primary has-[:focus-visible]:ring-ring flex cursor-pointer flex-col rounded-md border p-3 text-sm has-[:focus-visible]:ring-2"
                  >
                    <input
                      type="radio"
                      name="key-kind"
                      value={value}
                      checked={keyKind === value}
                      onChange={() => setKeyKind(value)}
                      className="sr-only"
                    />
                    <span className="font-medium">{title}</span>
                    <span className="text-muted-foreground text-xs">{hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {keyKind === 'publishable' && (
              <div className="space-y-2">
                <Label htmlFor="key-origins">Allowed origins</Label>
                <Textarea
                  id="key-origins"
                  value={origins}
                  onChange={(e) => setOrigins(e.target.value)}
                  rows={3}
                  placeholder="https://www.example.com"
                  aria-describedby="key-origins-hint"
                  className="font-mono text-sm"
                />
                <p id="key-origins-hint" className="text-muted-foreground text-xs">
                  One per line, exactly as the browser sends it (scheme and host, no path). The key
                  works from these sites only.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={isCreating}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                isCreating || !keyName.trim() || (keyKind === 'publishable' && !origins.trim())
              }
            >
              {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Key Display Dialog */}
      <Dialog open={!!newKey} onOpenChange={() => handleCloseNewKey()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>
              Copy this key now. You won&apos;t be able to see it again.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <div className="flex items-center gap-2">
              <Input value={newKey || ''} readOnly className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={handleCopyKey}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleCloseNewKey}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Confirmation */}
      <AlertDialog open={!!revokeId} onOpenChange={() => setRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API Key</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently disable this API key. Any integrations using it will stop
              working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={isRevoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
