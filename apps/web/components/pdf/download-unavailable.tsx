'use client';

import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface DownloadUnavailableProps {
  children: ReactNode;
  className?: string;
}

/**
 * Wraps a disabled download button with an "Available after saving" tooltip.
 * Disabled buttons don't fire pointer events, so the tooltip trigger is a focusable wrapper.
 */
export function DownloadUnavailable({ children, className }: DownloadUnavailableProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={className}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>Available after saving</TooltipContent>
    </Tooltip>
  );
}
