'use client';

import { useState } from 'react';
import { Loader2, PenLine } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SignaturePad } from './signature-pad';
import { counterSignContract } from '@/lib/contracts/actions';
import type { SignatureData } from '@/lib/contracts/types';

interface CountersignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string;
  contractName: string;
  onCountersigned?: () => void;
}

export function CountersignDialog({
  open,
  onOpenChange,
  contractId,
  contractName,
  onCountersigned,
}: CountersignDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signature, setSignature] = useState<SignatureData | null>(null);

  const handleSubmit = async () => {
    if (!signature) {
      toast.error('Please provide your signature');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await counterSignContract(contractId, signature);
      if (!result.success) {
        toast.error(result.error || 'Failed to countersign contract');
        return;
      }
      toast.success('Contract countersigned successfully');
      onOpenChange(false);
      onCountersigned?.();
    } catch {
      toast.error('Failed to countersign contract');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px]! max-h-[85vh]! p-0! gap-0! flex! flex-col! overflow-hidden">
        <div className="shrink-0 p-6 pb-3">
          <DialogHeader>
            <DialogTitle>Countersign Contract</DialogTitle>
            <DialogDescription>
              Apply your business signature to &quot;{contractName}&quot;. The client has already
              signed this contract.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
          <SignaturePad onSignatureChange={setSignature} />

          <p className="text-muted-foreground text-xs">
            By countersigning, you confirm that you have reviewed and agree to the terms of this
            contract. Your signature will be recorded along with a timestamp for verification
            purposes.
          </p>
        </div>

        <div className="bg-background shrink-0 border-t p-4">
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting || !signature}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <PenLine className="mr-2 h-4 w-4" />
              Countersign
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
