-- A viewed invoice is still unpaid. The ageing view left it out, so AI answers
-- and reports undercounted receivables once a client had opened an invoice.
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
  AND i.status IN ('sent', 'viewed', 'partial', 'overdue')
  AND i.amount_due > 0;
