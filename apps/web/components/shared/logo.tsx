'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BETA_TOOLTIP_MESSAGE } from '@/lib/constants/beta';

interface LogoProps {
  href?: string;
  showText?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: {
    icon: 'w-6 h-6',
    text: 'text-sm',
    letter: 'text-sm',
  },
  md: {
    icon: 'w-8 h-8',
    text: 'text-xl',
    letter: 'text-lg',
  },
  lg: {
    icon: 'w-10 h-10',
    text: 'text-2xl',
    letter: 'text-xl',
  },
};

export function Logo({ href, showText = true, className, size = 'md' }: LogoProps) {
  const sizes = sizeClasses[size];

  const content = (
    <div className={cn('flex items-center space-x-2', className)}>
      <div
        className={cn(
          'bg-linear-to-br flex items-center justify-center rounded-lg from-blue-600 to-violet-600',
          sizes.icon
        )}
      >
        <span className={cn('font-bold text-white', sizes.letter)}>Q</span>
      </div>
      {showText && (
        <span
          className={cn(
            'flex items-center gap-1 font-bold text-slate-900 dark:text-white',
            sizes.text
          )}
        >
          Wolff
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default text-sm font-medium text-blue-500">β</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[220px] text-center leading-relaxed">
              {BETA_TOOLTIP_MESSAGE}
            </TooltipContent>
          </Tooltip>
        </span>
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="transition-opacity hover:opacity-90">
        {content}
      </Link>
    );
  }

  return content;
}
