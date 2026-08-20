'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AssistantPanel } from './assistant-panel';

/**
 * Shows the assistant button only when the AI service is up (the
 * "web hides the assistant" rule); renders nothing otherwise, so the rest of
 * the header and the app are unchanged when AI is off or down.
 */
export function AssistantLauncher() {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/assistant/status', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { available: false }))
      .then((body: { available?: unknown }) => {
        if (active) setAvailable(body.available === true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!available) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Open the assistant"
        className="gap-1.5"
      >
        <Sparkles className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Assistant</span>
      </Button>
      <AssistantPanel open={open} onOpenChange={setOpen} />
    </>
  );
}
