'use client';

import { useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  Play,
  Pause,
  Check,
  X,
  Clock,
  Mail,
  UserCheck,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  createAutomation,
  updateAutomation,
  deleteAutomation,
  approveRun,
  rejectRun,
} from '@/lib/automations/actions';
import { AUTOMATION_TRIGGERS, type AutomationStep, type AutomationTrigger } from '@wolff/contracts';
import type { AutomationListItem, AutomationRunListItem } from '@/lib/automations/types';

interface Props {
  automations: AutomationListItem[];
  runs: AutomationRunListItem[];
  approvals: AutomationRunListItem[];
}

const STEP_TYPES: { value: AutomationStep['type']; label: string; icon: React.ReactNode }[] = [
  { value: 'wait', label: 'Wait', icon: <Clock className="h-4 w-4" /> },
  { value: 'send_email', label: 'Send email', icon: <Mail className="h-4 w-4" /> },
  { value: 'approval', label: 'Approval', icon: <UserCheck className="h-4 w-4" /> },
  { value: 'ai_draft_email', label: 'AI draft email', icon: <Sparkles className="h-4 w-4" /> },
  { value: 'move_deal', label: 'Move deal', icon: <ArrowRight className="h-4 w-4" /> },
];

const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  'invoice.overdue': 'Invoice overdue',
  'quote.sent_no_response': 'Quote sent, no response',
  'deal.stalled': 'Deal stalled',
};

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-100 text-blue-800',
  waiting_approval: 'bg-amber-100 text-amber-800',
  done: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
};

export function AutomationBuilder({ automations: initial, runs, approvals }: Props) {
  const [automations, setAutomations] = useState(initial);
  const [editing, setEditing] = useState<AutomationListItem | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<AutomationTrigger>('invoice.overdue');
  const [isActive, setIsActive] = useState(true);
  const [steps, setSteps] = useState<AutomationStep[]>([{ type: 'wait', days: 7 }]);

  const resetForm = (automation?: AutomationListItem) => {
    if (automation) {
      setName(automation.name);
      setTrigger(automation.trigger as AutomationTrigger);
      setIsActive(automation.isActive);
      setSteps(automation.steps.length > 0 ? automation.steps : [{ type: 'wait', days: 7 }]);
    } else {
      setName('');
      setTrigger('invoice.overdue');
      setIsActive(true);
      setSteps([{ type: 'wait', days: 7 }]);
    }
  };

  const openNew = () => {
    setEditing(null);
    resetForm();
    setIsOpen(true);
  };

  const openEdit = (automation: AutomationListItem) => {
    setEditing(automation);
    resetForm(automation);
    setIsOpen(true);
  };

  const save = async () => {
    const payload = { name, trigger, steps, isActive };
    if (editing) {
      await updateAutomation(editing.id, payload);
    } else {
      await createAutomation(payload);
    }
    setIsOpen(false);
    window.location.reload();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this automation?')) return;
    await deleteAutomation(id);
    window.location.reload();
  };

  const addStep = (type: AutomationStep['type']) => {
    const base: AutomationStep =
      type === 'wait'
        ? { type, days: 7 }
        : type === 'send_email'
          ? { type, templateId: '' }
          : type === 'approval'
            ? { type, role: 'owner' }
            : type === 'move_deal'
              ? { type, stageId: '' }
              : { type: 'ai_draft_email' };
    setSteps((s) => [...s, base]);
  };

  const updateStep = (index: number, patch: Partial<AutomationStep>) => {
    setSteps((s) =>
      s.map((step, i) => (i === index ? ({ ...step, ...patch } as AutomationStep) : step))
    );
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= steps.length) return;
    setSteps((s) => {
      const copy = [...s];
      const temp = copy[index]!;
      copy[index] = copy[next]!;
      copy[next] = temp;
      return copy;
    });
  };

  const removeStep = (index: number) => setSteps((s) => s.filter((_, i) => i !== index));

  return (
    <Tabs defaultValue="builder">
      <TabsList>
        <TabsTrigger value="builder">Builder</TabsTrigger>
        <TabsTrigger value="runs">Run timeline</TabsTrigger>
        <TabsTrigger value="approvals">
          Approvals {approvals.length > 0 && `(${approvals.length})`}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="builder" className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Automations</h2>
          <Button onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" /> New automation
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {automations.map((a) => (
            <Card
              key={a.id}
              className="hover:border-primary cursor-pointer"
              onClick={() => openEdit(a)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-base">{a.name}</CardTitle>
                  <Badge variant={a.isActive ? 'default' : 'secondary'}>
                    {a.isActive ? 'Active' : 'Paused'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  {TRIGGER_LABELS[a.trigger as AutomationTrigger]}
                </p>
                <p className="text-muted-foreground text-xs">{a.stepCount} step(s)</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </TabsContent>

      <TabsContent value="runs" className="space-y-4">
        <RunTimeline runs={runs} />
      </TabsContent>

      <TabsContent value="approvals" className="space-y-4">
        <ApprovalsInbox approvals={approvals} />
      </TabsContent>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit automation' : 'New automation'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Trigger</Label>
              <Select value={trigger} onValueChange={(v) => setTrigger(v as AutomationTrigger)}>
                <SelectTrigger>
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
            </div>
            <div className="flex items-center gap-2">
              <Switch id="active" checked={isActive} onCheckedChange={setIsActive} />
              <Label htmlFor="active">Active</Label>
            </div>

            <div className="space-y-2">
              <Label>Steps</Label>
              <ScrollArea className="h-72 rounded-md border p-2">
                <div className="space-y-3">
                  {steps.map((step, i) => (
                    <StepEditor
                      key={i}
                      index={i}
                      step={step}
                      onChange={(patch) => updateStep(i, patch)}
                      onMove={(dir) => moveStep(i, dir)}
                      onRemove={() => removeStep(i)}
                      isFirst={i === 0}
                      isLast={i === steps.length - 1}
                    />
                  ))}
                </div>
              </ScrollArea>
              <div className="flex flex-wrap gap-2">
                {STEP_TYPES.map((t) => (
                  <Button
                    key={t.value}
                    variant="outline"
                    size="sm"
                    onClick={() => addStep(t.value)}
                  >
                    <Plus className="mr-1 h-3 w-3" /> {t.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              {editing && (
                <Button variant="destructive" onClick={() => remove(editing.id)}>
                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                </Button>
              )}
              <Button variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={!name || steps.length === 0}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}

function StepEditor({
  index,
  step,
  onChange,
  onMove,
  onRemove,
  isFirst,
  isLast,
}: {
  index: number;
  step: AutomationStep;
  onChange: (patch: Partial<AutomationStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const type = step.type;
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between">
        <Badge variant="outline">Step {index + 1}</Badge>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" disabled={isFirst} onClick={() => onMove(-1)}>
            ↑
          </Button>
          <Button variant="ghost" size="icon" disabled={isLast} onClick={() => onMove(1)}>
            ↓
          </Button>
          <Button variant="ghost" size="icon" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {type === 'wait' && (
        <div className="grid gap-2">
          <Label>Wait days</Label>
          <Input
            type="number"
            min={0}
            max={365}
            value={step.days}
            onChange={(e) => onChange({ days: Number(e.target.value) })}
          />
        </div>
      )}
      {type === 'send_email' && (
        <div className="grid gap-2">
          <Label>Email template ID</Label>
          <Input
            value={step.templateId}
            onChange={(e) => onChange({ templateId: e.target.value })}
            placeholder="Template UUID"
          />
        </div>
      )}
      {type === 'approval' && (
        <div className="grid gap-2">
          <Label>Required role</Label>
          <Select value={step.role} onValueChange={(v) => onChange({ role: v as any })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="owner">Owner</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="member">Member</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {type === 'move_deal' && (
        <div className="grid gap-2">
          <Label>Target stage ID</Label>
          <Input
            value={step.stageId}
            onChange={(e) => onChange({ stageId: e.target.value })}
            placeholder="Stage UUID"
          />
        </div>
      )}
      {type === 'ai_draft_email' && (
        <p className="text-muted-foreground text-sm">AI will draft an email when this step runs.</p>
      )}
    </div>
  );
}

function RunTimeline({ runs }: { runs: AutomationRunListItem[] }) {
  return (
    <div className="space-y-3">
      {runs.map((run) => (
        <Card key={run.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{run.automationName}</CardTitle>
              <Badge className={STATUS_COLORS[run.status] ?? 'bg-gray-100'}>{run.status}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-muted-foreground text-sm">Step {run.currentStep}</p>
            {run.log.length > 0 && (
              <ul className="text-muted-foreground space-y-1 text-xs">
                {run.log.map((entry, i) => (
                  <li key={i}>
                    {new Date(entry.at).toLocaleString()} — {entry.message}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
      {runs.length === 0 && <p className="text-muted-foreground text-sm">No runs yet.</p>}
    </div>
  );
}

function ApprovalsInbox({ approvals }: { approvals: AutomationRunListItem[] }) {
  const [items, setItems] = useState(approvals);

  const decide = async (id: string, approved: boolean) => {
    if (approved) await approveRun(id);
    else await rejectRun(id);
    setItems((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="space-y-3">
      {items.map((run) => (
        <Card key={run.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{run.automationName}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-3 text-sm">
              Waiting for approval at step {run.currentStep + 1}.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => decide(run.id, true)}>
                <Check className="mr-1 h-4 w-4" /> Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide(run.id, false)}>
                <X className="mr-1 h-4 w-4" /> Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      {items.length === 0 && <p className="text-muted-foreground text-sm">No approvals pending.</p>}
    </div>
  );
}
