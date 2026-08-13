'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { MotionConfig } from 'motion/react';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Loader2, Trash2 } from 'lucide-react';
import {
  AUTOMATION_TRIGGERS,
  createAutomationSchema,
  type AutomationTrigger,
  type CreateAutomationInput,
} from '@wolff/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  createAutomation,
  deleteAutomation,
  updateAutomation,
  type ActionResult,
} from '@/lib/automations/actions';
import type { AutomationListItem, AutomationOptions } from '@/lib/automations/types';
import { StepList } from './step-list';
import { STEP_META, TRIGGER_LABELS } from './step-meta';

const EMPTY: CreateAutomationInput = {
  name: '',
  trigger: 'invoice.overdue',
  isActive: true,
  steps: [STEP_META.wait.create()],
};

/**
 * Create or edit an automation. One react-hook-form form,
 * validated with the same Zod schema the API uses.
 */
export function AutomationEditor({
  open,
  onOpenChange,
  automation,
  options,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  automation: AutomationListItem | null;
  options: AutomationOptions;
}) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const form = useForm<CreateAutomationInput>({
    resolver: zodResolver(createAutomationSchema),
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      automation
        ? {
            name: automation.name,
            trigger: automation.trigger as AutomationTrigger,
            isActive: automation.isActive,
            steps: automation.steps.length ? automation.steps : EMPTY.steps,
          }
        : EMPTY
    );
  }, [open, automation, form]);

  const finish = (result: ActionResult, done: string) => {
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(done);
    onOpenChange(false);
    router.refresh();
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const result = automation
      ? await updateAutomation(automation.id, values)
      : await createAutomation(values);
    finish(result, automation ? 'Automation saved' : 'Automation created');
  });

  const onDelete = async () => {
    if (!automation) return;
    setIsDeleting(true);
    finish(await deleteAutomation(automation.id), 'Automation deleted');
    setIsDeleting(false);
  };

  const { errors, isSubmitting } = form.formState;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{automation ? 'Edit automation' : 'New automation'}</DialogTitle>
          <DialogDescription>
            When the trigger fires for a document, its run goes through the steps in order.
          </DialogDescription>
        </DialogHeader>
        <FormProvider {...form}>
          <MotionConfig reducedMotion="user">
            <form id="automation-form" onSubmit={onSubmit} className="space-y-6" noValidate>
              <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
                <div className="grid gap-1.5">
                  <Label htmlFor="automation-name">Name</Label>
                  <Input
                    id="automation-name"
                    placeholder="Overdue invoice follow-up"
                    aria-invalid={Boolean(errors.name)}
                    {...form.register('name')}
                  />
                  {errors.name && (
                    <p className="text-destructive text-xs">Give the automation a name</p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="automation-trigger">When</Label>
                  <Controller
                    control={form.control}
                    name="trigger"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="automation-trigger">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AUTOMATION_TRIGGERS.map((t) => (
                            <SelectItem key={t} value={t}>
                              {TRIGGER_LABELS[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>

              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-medium">Then</legend>
                <StepList options={options} />
              </fieldset>

              <Controller
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <div className="bg-muted/40 flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label htmlFor="automation-active">Active</Label>
                      <p className="text-muted-foreground text-xs">
                        A paused automation starts no new runs.
                      </p>
                    </div>
                    <Switch
                      id="automation-active"
                      checked={field.value ?? true}
                      onCheckedChange={field.onChange}
                    />
                  </div>
                )}
              />
            </form>
          </MotionConfig>
        </FormProvider>
        <DialogFooter className="gap-2 sm:justify-between">
          {automation ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
              disabled={isDeleting}
            >
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="automation-form" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
