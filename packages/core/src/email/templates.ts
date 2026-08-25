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

/** A calendar date in emails: "1 Dec 2026". Dates are stored at UTC midnight. */
function emailDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const button = (url: string, label: string, colour: string) => `
  <p style="margin: 24px 0;">
    <a href="${safeUrl(url)}" style="background-color: ${colour}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">${label}</a>
  </p>
  <p>Or copy this link: ${safeUrl(url)}</p>`;

/** The email a quote is sent with (`POST /v1/quotes/:id/send`). */
export function renderQuoteSent(input: {
  clientName: string;
  quoteName: string;
  quoteUrl: string;
  businessName: string;
  validUntil?: Date | null;
  message?: string | null;
}): RenderedEmail {
  const business = escapeHtml(input.businessName);
  return {
    subject: `Quote: ${input.quoteName} from ${input.businessName}`,
    html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2>New Quote from ${business}</h2>
  <p>Hi ${escapeHtml(input.clientName)},</p>
  <p>${business} has sent you a quote: <strong>${escapeHtml(input.quoteName)}</strong></p>${
    input.message ? `\n  <p>${escapeHtml(input.message)}</p>` : ''
  }${input.validUntil ? `\n  <p>This quote is valid until ${emailDate(input.validUntil)}.</p>` : ''}${button(
    input.quoteUrl,
    'View Quote',
    '#3B82F6'
  )}${footer(input.businessName)}
</div>`,
  };
}

/** The email an invoice is sent with (`POST /v1/invoices/:id/send`). */
export function renderInvoiceSent(input: {
  clientName: string;
  invoiceNumber: string;
  invoiceUrl: string;
  businessName: string;
  /** Already formatted in the invoice's currency (`formatMoney`). */
  amount: string;
  dueDate: Date;
  message?: string | null;
}): RenderedEmail {
  const business = escapeHtml(input.businessName);
  return {
    subject: `Invoice ${input.invoiceNumber} from ${input.businessName} - ${input.amount}`,
    html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2>Invoice from ${business}</h2>
  <p>Hi ${escapeHtml(input.clientName)},</p>
  <p>${business} has sent you an invoice:</p>
  <div style="background: #f9fafb; padding: 16px; border-radius: 8px; margin: 16px 0;">
    <p style="margin: 0;"><strong>Invoice:</strong> ${escapeHtml(input.invoiceNumber)}</p>
    <p style="margin: 8px 0 0;"><strong>Amount:</strong> ${escapeHtml(input.amount)}</p>
    <p style="margin: 8px 0 0;"><strong>Due Date:</strong> ${emailDate(input.dueDate)}</p>
  </div>${input.message ? `\n  <p>${escapeHtml(input.message)}</p>` : ''}${button(
    input.invoiceUrl,
    'View &amp; Pay Invoice',
    '#10B981'
  )}${footer(input.businessName)}
</div>`,
  };
}
