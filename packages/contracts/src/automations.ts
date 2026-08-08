import { z } from './zod';

export const AUTOMATION_TRIGGERS = [
  'invoice.overdue',
  'quote.sent_no_response',
  'deal.stalled',
] as const;

export const automationTriggerSchema = z.enum(AUTOMATION_TRIGGERS).openapi('AutomationTrigger');

export const automationStepSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('wait'), days: z.number().int().min(0).max(365) }),
    z.object({ type: z.literal('send_email'), templateId: z.string().uuid() }),
    z.object({ type: z.literal('approval'), role: z.enum(['owner', 'admin', 'member']) }),
    z.object({ type: z.literal('ai_draft_email') }),
    z.object({ type: z.literal('move_deal'), stageId: z.string().uuid() }),
  ])
  .openapi('AutomationStep');

export const createAutomationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    trigger: automationTriggerSchema,
    steps: z.array(automationStepSchema).min(1).max(20),
    isActive: z.boolean().optional(),
  })
  .openapi('CreateAutomation');

export const updateAutomationSchema = createAutomationSchema.partial().openapi('UpdateAutomation');

export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type AutomationStep = z.infer<typeof automationStepSchema>;
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;
