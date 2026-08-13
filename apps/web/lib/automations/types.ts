import type { AutomationStep, AutomationTrigger } from '@wolff/contracts';

export interface AutomationListItem {
  id: string;
  name: string;
  trigger: string;
  isActive: boolean;
  stepCount: number;
  steps: AutomationStep[];
  createdAt: Date;
}

export interface AutomationFormInput {
  name: string;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  isActive?: boolean;
}

export interface AutomationRunListItem {
  id: string;
  automationId: string;
  automationName: string;
  trigger: string;
  subjectId: string;
  currentStep: number;
  status: string;
  log: { at: string; stepIndex: number; action: string; message: string }[];
  createdAt: Date;
  updatedAt: Date;
}

/** What the step forms offer to pick from, instead of raw ids. */
export interface AutomationOptions {
  templates: { id: string; name: string }[];
  stages: { id: string; name: string; pipelineName: string }[];
}
