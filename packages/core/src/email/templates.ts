import { PRODUCT_NAME } from '../brand';

/** HTML email bodies the worker sends. Every interpolated value is escaped. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) URLs may become an href. */
function safeUrl(url: string): string {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? escapeHtml(url) : '#';
  } catch {
    return '#';
  }
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

const footer = (businessName: string) => `
  <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;" />
  <p style="color: #666; font-size: 14px;">
    Sent via ${PRODUCT_NAME} on behalf of ${escapeHtml(businessName)}
  </p>`;

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function renderInvoiceReminder(input: {
  clientName: string;
  invoiceNumber: string;
  invoiceUrl: string;
  businessName: string;
  amount: string;
  dueDate: string;
  daysOverdue: number;
}): RenderedEmail {
  const overdue = input.daysOverdue > 0;
  const colour = overdue ? '#EF4444' : '#F59E0B';
  const number = escapeHtml(input.invoiceNumber);
  const days = `${input.daysOverdue} day${input.daysOverdue === 1 ? '' : 's'}`;

  return {
    subject: overdue
      ? `Overdue: Invoice ${input.invoiceNumber} - ${input.amount} (${days} past due)`
      : `Reminder: Invoice ${input.invoiceNumber} from ${input.businessName}`,
    html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: ${colour};">${overdue ? 'Invoice Overdue' : 'Invoice Reminder'}</h2>
  <p>Hi ${escapeHtml(input.clientName)},</p>
  <p>${
    overdue
      ? `This is a reminder that invoice ${number} is now ${days} past due.`
      : `This is a friendly reminder that invoice ${number} is due on ${escapeHtml(input.dueDate)}.`
  }</p>
  <div style="padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid ${colour};">
    <p style="margin: 0;"><strong>Invoice:</strong> ${number}</p>
    <p style="margin: 8px 0 0;"><strong>Amount:</strong> ${escapeHtml(input.amount)}</p>
    <p style="margin: 8px 0 0;"><strong>Due date:</strong> ${escapeHtml(input.dueDate)}</p>
  </div>
  <p style="margin: 24px 0;">
    <a href="${safeUrl(input.invoiceUrl)}" style="background-color: ${colour}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pay now</a>
  </p>${footer(input.businessName)}
</div>`,
  };
}

export function renderPaymentReceived(input: {
  clientName: string;
  invoiceNumber: string;
  businessName: string;
  amount: string;
  receiptUrl?: string | null;
}): RenderedEmail {
  return {
    subject: `Payment received for invoice ${input.invoiceNumber}`,
    html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #10B981;">Payment Received</h2>
  <p>Hi ${escapeHtml(input.clientName)},</p>
  <p>Thank you. We received your payment of <strong>${escapeHtml(input.amount)}</strong> for invoice ${escapeHtml(input.invoiceNumber)}.</p>${
    input.receiptUrl
      ? `\n  <p style="margin: 24px 0;"><a href="${safeUrl(input.receiptUrl)}">View receipt</a></p>`
      : ''
  }${footer(input.businessName)}
</div>`,
  };
}
