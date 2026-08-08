import type { AutomationStep, AutomationTrigger } from '@wolff/contracts';

export interface AutomationListItem {
  id: string;
  name: string;
  trigger: string;
  isActive: boolean;
  stepCount: number;
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
