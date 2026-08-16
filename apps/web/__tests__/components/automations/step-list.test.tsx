import { render } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import type { CreateAutomationInput } from '@wolff/contracts';
import { StepList } from '@/components/automations/step-list';

function Harness() {
  const form = useForm<CreateAutomationInput>({
    defaultValues: {
      name: 'Nudge',
      trigger: 'invoice.overdue',
      steps: [
        { type: 'wait', days: 7 },
        { type: 'approval', role: 'admin' },
      ],
    },
  });
  return (
    <FormProvider {...form}>
      <StepList options={{ templates: [], stages: [] }} />
    </FormProvider>
  );
}

describe('StepList', () => {
  it('puts only list items directly inside the steps list', () => {
    const { getByRole } = render(<Harness />);

    const list = getByRole('list', { name: 'Steps' });

    expect(list.children.length).toBe(2);
    for (const child of Array.from(list.children)) expect(child.tagName).toBe('LI');
  });
});
