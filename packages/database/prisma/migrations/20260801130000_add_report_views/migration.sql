-- SQL views that are the single source of truth for dashboard and AI reports.
-- They are owned by Prisma migrations so every environment (local, demo, CI, production)
-- has identical report numbers.

-- Receivables ageing: outstanding amount grouped by days past due date.
-- Only sent/partial/overdue invoices with an amount due > 0 are included.
CREATE OR REPLACE VIEW v_receivables_ageing AS
SELECT
    i.workspace_id AS workspace_id,
    i.id AS invoice_id,
    i.client_id,
    i.invoice_number,
    i.currency,
    i.total,
    i.amount_due,
    i.due_date,
    GREATEST(CURRENT_DATE - i.due_date, 0) AS days_overdue,
    CASE
        WHEN CURRENT_DATE <= i.due_date THEN 'current'
        WHEN CURRENT_DATE - i.due_date <= 30 THEN 'bucket_0_30'
        WHEN CURRENT_DATE - i.due_date <= 60 THEN 'bucket_31_60'
        WHEN CURRENT_DATE - i.due_date <= 90 THEN 'bucket_61_90'
        ELSE 'bucket_90_plus'
    END AS bucket
FROM invoices i
WHERE i.deleted_at IS NULL
  AND i.status IN ('sent', 'partial', 'overdue')
  AND i.amount_due > 0;

-- Monthly revenue: payments that completed in a calendar month, by currency.
CREATE OR REPLACE VIEW v_revenue_monthly AS
SELECT
    p.workspace_id,
    DATE_TRUNC('month', p.processed_at)::date AS month,
    p.currency,
    SUM(p.amount) AS revenue,
    COUNT(*) AS payment_count
FROM payments p
WHERE p.deleted_at IS NULL
  AND p.status = 'completed'
  AND p.processed_at IS NOT NULL
GROUP BY p.workspace_id, DATE_TRUNC('month', p.processed_at), p.currency;

-- GST outward supplies (GSTR-1 style): one row per invoice line with GST details.
-- Includes only invoices that have left draft and have GST lines.
CREATE OR REPLACE VIEW v_gst_outward_supplies AS
SELECT
    i.workspace_id,
    i.id AS invoice_id,
    i.invoice_number,
    i.issue_date,
    i.supply_type::text AS supply_type,
    i.reverse_charge,
    i.supplier_gstin,
    i.recipient_gstin,
    li.hsn_sac,
    li.gst_rate,
    li.taxable_value,
    li.cgst_amount,
    li.sgst_amount,
    li.igst_amount,
    li.cess_amount,
    (li.taxable_value + li.cgst_amount + li.sgst_amount + li.igst_amount + li.cess_amount) AS line_total
FROM invoices i
JOIN invoice_line_items li ON li.invoice_id = i.id
WHERE i.deleted_at IS NULL
  AND i.status != 'draft'
  AND (li.cgst_amount > 0 OR li.sgst_amount > 0 OR li.igst_amount > 0 OR li.cess_amount > 0);

-- Pipeline stage transitions: current deal stage snapshot with stage metadata.
-- Used for conversion and velocity reports.
CREATE OR REPLACE VIEW v_pipeline_stage_transitions AS
SELECT
    d.workspace_id,
    d.id AS deal_id,
    d.title,
    d.value,
    d.currency,
    d.pipeline_id,
    p.name AS pipeline_name,
    d.stage_id,
    s.name AS stage_name,
    s.position AS stage_position,
    s.kind AS stage_kind,
    s.probability,
    d.lead_id,
    d.client_id,
    d.owner_id,
    d.expected_close_date,
    d.created_at AS deal_created_at,
    d.won_at,
    d.lost_at,
    d.deleted_at
FROM deals d
JOIN pipelines p ON p.id = d.pipeline_id
JOIN pipeline_stages s ON s.id = d.stage_id
WHERE d.deleted_at IS NULL;
