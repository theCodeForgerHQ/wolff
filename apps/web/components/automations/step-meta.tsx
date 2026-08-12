import { ArrowRight, Clock, Mail, Sparkles, UserCheck, type LucideIcon } from 'lucide-react';
import type { AutomationStep, AutomationTrigger } from '@wolff/contracts';

export type StepType = AutomationStep['type'];

interface StepMeta {
  label: string;
  /** One line under the step's title, saying what it does when the run reaches it. */
  hint: string;
  icon: LucideIcon;
  /** Tailwind classes for the step's marker on the rail. Approval stands out: it stops the run. */
  tone: string;
  create: () => AutomationStep;
}

export const STEP_META: Record<StepType, StepMeta> = {
  wait: {
    label: 'Wait',
    hint: 'Pause the run for a number of days.',
    icon: Clock,
    tone: 'bg-muted text-muted-foreground ring-border',
    create: () => ({ type: 'wait', days: 7 }),
  },
  send_email: {
    label: 'Send email',
    hint: 'Email the client using one of your templates.',
    icon: Mail,
    tone: 'bg-primary/10 text-primary ring-primary/30',
    create: () => ({ type: 'send_email', templateId: '' }),
  },
  approval: {
    label: 'Approval',
    hint: 'Stop until someone with this role approves in the inbox.',
    icon: UserCheck,
    tone: 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
    create: () => ({ type: 'approval', role: 'owner' }),
  },
  ai_draft_email: {
    label: 'AI draft email',
    hint: 'Draft a follow-up for review (skipped until the AI service exists).',
    icon: Sparkles,
    tone: 'bg-muted text-muted-foreground ring-border',
    create: () => ({ type: 'ai_draft_email' }),
  },
  move_deal: {
    label: 'Move deal',
    hint: 'Move the deal to another stage of its pipeline.',
    icon: ArrowRight,
    tone: 'bg-muted text-foreground ring-border',
    create: () => ({ type: 'move_deal', stageId: '' }),
  },
};

export const STEP_ORDER: StepType[] = [
  'wait',
  'send_email',
  'approval',
  'move_deal',
  'ai_draft_email',
];

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  'invoice.overdue': 'Invoice overdue',
  'quote.sent_no_response': 'Quote sent, no response',
  'deal.stalled': 'Deal stalled',
};

/** A short phrase for a configured step, as shown in the flow chain. */
export function describeStep(step: AutomationStep, names: { stage?: string; template?: string }) {
  switch (step.type) {
    case 'wait':
      return `Wait ${step.days} day${step.days === 1 ? '' : 's'}`;
    case 'send_email':
      return names.template ? `Email: ${names.template}` : 'Send email';
    case 'approval':
      return `Approval (${step.role})`;
    case 'move_deal':
      return names.stage ? `Move to ${names.stage}` : 'Move deal';
    case 'ai_draft_email':
      return 'AI draft';
  }
}
