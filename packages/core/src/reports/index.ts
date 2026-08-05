import type { Db } from '../context';

/**
 * Reports served from SQL views owned by Prisma migrations.
 * These functions are tenant-guarded: they always filter by workspaceId and
 * return plain objects so they can be used from the API, the web app, and
 * the AI service (via pandas).
 */

export interface ReceivablesAgeingRow {
  invoiceId: string;
  clientId: string;
  invoiceNumber: string;
  currency: string;
  total: number;
  amountDue: number;
  dueDate: Date;
  daysOverdue: number;
  bucket: string;
}

export async function getReceivablesAgeing(
  db: Db,
  workspaceId: string
): Promise<ReceivablesAgeingRow[]> {
  const rows = await db.$queryRaw<
    {
      invoice_id: string;
      client_id: string;
      invoice_number: string;
      currency: string;
      total: number;
      amount_due: number;
      due_date: Date;
      days_overdue: number;
      bucket: string;
    }[]
  >`SELECT * FROM v_receivables_ageing WHERE workspace_id = ${workspaceId}`;
  return rows.map((r) => ({
    invoiceId: r.invoice_id,
    clientId: r.client_id,
    invoiceNumber: r.invoice_number,
    currency: r.currency,
    total: Number(r.total),
    amountDue: Number(r.amount_due),
    dueDate: r.due_date,
    daysOverdue: r.days_overdue,
    bucket: r.bucket,
  }));
}

export interface RevenueMonthlyRow {
  month: Date;
  currency: string;
  revenue: number;
  paymentCount: number;
}

export async function getRevenueMonthly(db: Db, workspaceId: string): Promise<RevenueMonthlyRow[]> {
  const rows = await db.$queryRaw<
    {
      month: Date;
      currency: string;
      revenue: number;
      payment_count: number;
    }[]
  >`SELECT * FROM v_revenue_monthly WHERE workspace_id = ${workspaceId} ORDER BY month`;
  return rows.map((r) => ({
    month: r.month,
    currency: r.currency,
    revenue: Number(r.revenue),
    paymentCount: Number(r.payment_count),
  }));
}

export interface GstOutwardSupplyRow {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: Date;
  supplyType: string;
  reverseCharge: boolean;
  supplierGstin: string | null;
  recipientGstin: string | null;
  hsnSac: string | null;
  gstRate: number | null;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  lineTotal: number;
}

export async function getGstOutwardSupplies(
  db: Db,
  workspaceId: string
): Promise<GstOutwardSupplyRow[]> {
  const rows = await db.$queryRaw<
    {
      invoice_id: string;
      invoice_number: string;
      issue_date: Date;
      supply_type: string;
      reverse_charge: boolean;
      supplier_gstin: string | null;
      recipient_gstin: string | null;
      hsn_sac: string | null;
      gst_rate: number | null;
      taxable_value: number;
      cgst_amount: number;
      sgst_amount: number;
      igst_amount: number;
      cess_amount: number;
      line_total: number;
    }[]
  >`SELECT * FROM v_gst_outward_supplies WHERE workspace_id = ${workspaceId} ORDER BY issue_date, invoice_id`;
  return rows.map((r) => ({
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    issueDate: r.issue_date,
    supplyType: r.supply_type,
    reverseCharge: r.reverse_charge,
    supplierGstin: r.supplier_gstin,
    recipientGstin: r.recipient_gstin,
    hsnSac: r.hsn_sac,
    gstRate: r.gst_rate ? Number(r.gst_rate) : null,
    taxableValue: Number(r.taxable_value),
    cgstAmount: Number(r.cgst_amount),
    sgstAmount: Number(r.sgst_amount),
    igstAmount: Number(r.igst_amount),
    cessAmount: Number(r.cess_amount),
    lineTotal: Number(r.line_total),
  }));
}

export interface PipelineStageRow {
  dealId: string;
  title: string;
  value: number;
  currency: string;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  stagePosition: number;
  stageKind: string;
  probability: number;
  leadId: string | null;
  clientId: string | null;
  ownerId: string | null;
  expectedCloseDate: Date | null;
  dealCreatedAt: Date;
  wonAt: Date | null;
  lostAt: Date | null;
}

export async function getPipelineStageTransitions(
  db: Db,
  workspaceId: string
): Promise<PipelineStageRow[]> {
  const rows = await db.$queryRaw<
    {
      deal_id: string;
      title: string;
      value: number;
      currency: string;
      pipeline_id: string;
      pipeline_name: string;
      stage_id: string;
      stage_name: string;
      stage_position: number;
      stage_kind: string;
      probability: number;
      lead_id: string | null;
      client_id: string | null;
      owner_id: string | null;
      expected_close_date: Date | null;
      deal_created_at: Date;
      won_at: Date | null;
      lost_at: Date | null;
    }[]
  >`SELECT * FROM v_pipeline_stage_transitions WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ORDER BY stage_position, deal_created_at`;
  return rows.map((r) => ({
    dealId: r.deal_id,
    title: r.title,
    value: Number(r.value),
    currency: r.currency,
    pipelineId: r.pipeline_id,
    pipelineName: r.pipeline_name,
    stageId: r.stage_id,
    stageName: r.stage_name,
    stagePosition: r.stage_position,
    stageKind: r.stage_kind,
    probability: r.probability,
    leadId: r.lead_id,
    clientId: r.client_id,
    ownerId: r.owner_id,
    expectedCloseDate: r.expected_close_date,
    dealCreatedAt: r.deal_created_at,
    wonAt: r.won_at,
    lostAt: r.lost_at,
  }));
}
