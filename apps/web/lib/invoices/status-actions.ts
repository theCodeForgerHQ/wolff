'use server';

import { revalidatePath } from 'next/cache';
import { prisma, type Prisma } from '@wolff/database';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import type { InvoiceStatus } from './types';
import { sendTemplatedEmail } from '@/lib/email/actions';
import { createNotification } from '@/lib/notifications/internal';
import { logger } from '@/lib/logger';
import { formatCurrency, toNumber, getBaseUrl } from '@/lib/utils';
import { ROUTES } from '@/lib/routes';
import { domainEvents } from '@/lib/events/emitter';
import { getActiveWorkspace, issueBlocker } from './action-helpers';

/**
 * Update invoice status
 */
export async function updateInvoiceStatus(invoiceId: string, status: InvoiceStatus) {
  const { userId, workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();

  // Bug #456: RBAC — viewers cannot change invoice status
  if (role === 'viewer') {
    return {
      success: false,
      error: 'Insufficient permissions: viewers cannot change invoice status',
    };
  }

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
  });

  if (!invoice) {
    return { success: false, error: 'Invoice not found' };
  }

  // Validate status transitions
  const allowedTransitions: Record<string, string[]> = {
    draft: ['sent', 'voided'],
    sent: ['viewed', 'paid', 'partial', 'voided'],
    viewed: ['paid', 'partial', 'voided'],
    partial: ['paid', 'voided'],
    paid: ['voided'],
    overdue: ['paid', 'partial', 'voided'],
    voided: [],
  };

  const allowed = allowedTransitions[invoice.status];
  if (allowed && !allowed.includes(status)) {
    return {
      success: false,
      error: `Cannot transition from '${invoice.status}' to '${status}'`,
    };
  }

  // Leaving draft: a GST invoice must carry Rule 46's mandatory details.
  if (invoice.status === 'draft' && status !== 'voided') {
    const blocker = await issueBlocker(workspace.id, invoiceId);
    if (blocker) return { success: false, error: blocker };
  }

  // Enforce payment constraints for payment-related statuses
  const amountPaid = toNumber(invoice.amountPaid);
  const total = toNumber(invoice.total);
  if (status === 'paid' && amountPaid < total) {
    return {
      success: false,
      error: `Cannot mark as paid: amount paid ($${amountPaid.toFixed(2)}) is less than total ($${total.toFixed(2)})`,
    };
  }
  if (status === 'partial' && (amountPaid <= 0 || amountPaid >= total)) {
    return {
      success: false,
      error: 'Cannot mark as partial: amount paid must be between $0 and the total',
    };
  }

  const updateData: Prisma.InvoiceUpdateInput = {
    status,
  };

  // Set timestamps based on status
  if (status === 'sent' && !invoice.sentAt) {
    updateData.sentAt = new Date();
  } else if (status === 'paid' || status === 'partial') {
    if (!invoice.paidAt) updateData.paidAt = new Date();
    if (status === 'paid') {
      // Bug #16: Only override amountPaid if it doesn't already match total
      // This preserves the payment ledger when payments were recorded incrementally
      if (Math.abs(amountPaid - total) > 0.01) {
        updateData.amountPaid = invoice.total;
      }
      updateData.amountDue = 0;
    }
  } else if (status === 'voided') {
    updateData.voidedAt = new Date();
    updateData.amountDue = 0;
  }

  await prisma.$transaction([
    prisma.invoice.update({
      where: { id: invoiceId },
      data: updateData,
    }),
    prisma.invoiceEvent.create({
      data: {
        invoiceId,
        eventType: `status_changed_to_${status}`,
        actorId: userId,
        actorType: 'user',
        metadata: { previousStatus: invoice.status },
      },
    }),
  ]);

  revalidatePath(ROUTES.invoices);
  revalidatePath(ROUTES.invoiceDetail(invoiceId));

  try {
    if (status === 'paid') {
      domainEvents.emit({
        type: 'invoice.paid',
        payload: { invoiceId, workspaceId: workspace.id, amount: toNumber(invoice.total) },
      });
    } else if (status === 'voided') {
      domainEvents.emit({
        type: 'invoice.voided',
        payload: { invoiceId, workspaceId: workspace.id },
      });
    }
  } catch {}

  return { success: true };
}

/**
 * Send invoice to client
 */
// Bug #105: Accept optional email customization from SendEmailDialog
interface SendEmailOptions {
  recipients?: string[];
  subject?: string;
  message?: string;
}

export async function sendInvoice(invoiceId: string, emailOptions?: SendEmailOptions) {
  // Fetch invoice with client for email first
  const { workspace } = await getActiveWorkspace();
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId: workspace.id, deletedAt: null },
    include: { client: true },
  });

  if (!invoice) {
    return { success: false, error: 'Invoice not found', emailSent: false };
  }

  if (!invoice.client?.email) {
    return { success: false, error: 'Client has no email address', emailSent: false };
  }

  // Do not email a GST invoice that may not leave draft.
  if (invoice.status === 'draft') {
    const blocker = await issueBlocker(workspace.id, invoiceId);
    if (blocker) return { success: false, error: blocker, emailSent: false };
  }

  // Try sending email FIRST — only update status if email succeeds
  const baseUrl = getBaseUrl();
  const invoiceUrl = `${baseUrl}/i/${invoice.accessToken}`;

  // Bug #105: Use custom recipients from dialog if provided
  const emailRecipients = emailOptions?.recipients?.length
    ? emailOptions.recipients
    : [invoice.client.email];

  let emailSent = false;
  try {
    const emailResult = await sendTemplatedEmail({
      type: 'invoice_sent',
      to: emailRecipients,
      variables: {
        businessName: workspace.name,
        businessEmail:
          (
            await prisma.businessProfile.findUnique({
              where: { workspaceId: workspace.id },
              select: { email: true },
            })
          )?.email || '',
        clientName: invoice.client.name,
        clientEmail: invoice.client.email,
        invoiceNumber: invoice.invoiceNumber,
        invoiceUrl,
        invoiceTotal: formatCurrency(toNumber(invoice.total), invoice.currency),
        amountDue: formatCurrency(toNumber(invoice.amountDue), invoice.currency),
        amountPaid: formatCurrency(toNumber(invoice.amountPaid), invoice.currency),
        invoiceDueDate: invoice.dueDate
          ? invoice.dueDate.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : undefined,
        message: emailOptions?.message || undefined,
      },
      customSubject: emailOptions?.subject || undefined,
    });
    emailSent = emailResult.success;
    if (!emailResult.success) {
      logger.error({ err: emailResult.error }, 'Failed to send invoice email');
      return {
        success: false,
        error: 'Email could not be sent. Please check your email settings.',
        emailSent: false,
      };
    }
  } catch (err) {
    logger.error({ err }, 'Failed to send invoice email');
    return {
      success: false,
      error: 'Email could not be sent. Please check your email settings.',
      emailSent: false,
    };
  }

  // Email sent successfully — update status to 'sent' (skip if already sent)
  if (invoice.status !== 'sent' && invoice.status !== 'viewed') {
    const result = await updateInvoiceStatus(invoiceId, 'sent');
    if (!result.success) {
      return { ...result, emailSent: true };
    }
  }

  // Create notification for sender
  const { userId } = await getCurrentUserWorkspace();
  createNotification({
    userId,
    workspaceId: workspace.id,
    type: 'invoice_sent',
    title: `Invoice ${invoice.invoiceNumber} sent`,
    message: `Sent to ${invoice.client.email}`,
    entityType: 'invoice',
    entityId: invoiceId,
    link: `/invoices/${invoiceId}`,
  }).catch(() => {});

  try {
    domainEvents.emit({
      type: 'invoice.sent',
      payload: { invoiceId, workspaceId: workspace.id, clientEmail: invoice.client.email },
    });
  } catch {}

  return { success: true, emailSent: true };
}

/**
 * Record a payment for an invoice
 */
export async function recordPayment(
  invoiceId: string,
  data: {
    amount: number;
    paymentMethod: string;
    referenceNumber?: string;
    notes?: string;
  }
) {
  const { userId, workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();

  // Bug #456: RBAC — viewers cannot record payments
  if (role === 'viewer') {
    return { success: false, error: 'Insufficient permissions: viewers cannot record payments' };
  }

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
  });

  if (!invoice) {
    return { success: false, error: 'Invoice not found' };
  }

  if (invoice.status === 'voided') {
    return { success: false, error: 'Cannot record payment for voided invoice' };
  }

  // Bug #125: Prevent payment on already-paid invoices
  if (invoice.status === 'paid') {
    return { success: false, error: 'This invoice is already fully paid' };
  }

  if (data.amount <= 0) {
    return { success: false, error: 'Payment amount must be greater than zero' };
  }

  // Bug #130: Validate amount is a finite number (prevents NaN, Infinity)
  if (!Number.isFinite(data.amount)) {
    return { success: false, error: 'Payment amount must be a valid number' };
  }

  // Bug #125: Prevent overpayment
  const currentAmountPaid = toNumber(invoice.amountPaid);
  const total = toNumber(invoice.total);
  const maxPayable = total - currentAmountPaid;
  if (data.amount > maxPayable) {
    return {
      success: false,
      error: `Payment exceeds remaining balance. Maximum payable: $${maxPayable.toFixed(2)}`,
    };
  }

  // Bug #67: Use interactive transaction with atomic increment to prevent race conditions
  const result = await prisma.$transaction(async (tx) => {
    // Atomically increment amountPaid
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        amountPaid: { increment: data.amount },
      },
      select: { amountPaid: true },
    });

    const newAmountPaid = toNumber(updated.amountPaid);
    const newAmountDue = total - newAmountPaid;

    // Determine new status
    let newStatus: InvoiceStatus;
    if (newAmountPaid >= total) {
      newStatus = 'paid';
    } else if (newAmountPaid > 0) {
      newStatus = 'partial';
    } else {
      newStatus = invoice.status as InvoiceStatus;
    }

    const payment = await tx.payment.create({
      data: {
        invoiceId,
        workspaceId: workspace.id,
        amount: data.amount,
        paymentMethod: data.paymentMethod,
        status: 'completed',
        referenceNumber: data.referenceNumber || null,
        notes: data.notes || null,
        processedAt: new Date(),
      },
    });

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        amountDue: Math.max(0, newAmountDue),
        status: newStatus,
        ...(!invoice.paidAt && { paidAt: new Date() }),
      },
    });

    await tx.invoiceEvent.create({
      data: {
        invoiceId,
        eventType: 'payment_recorded',
        actorId: userId,
        actorType: 'user',
        metadata: {
          amount: data.amount,
          paymentMethod: data.paymentMethod,
          newAmountPaid,
          newAmountDue,
        },
      },
    });

    return { paymentId: payment.id, newAmountPaid, newAmountDue, newStatus };
  });

  revalidatePath(ROUTES.invoices);
  revalidatePath(ROUTES.invoiceDetail(invoiceId));

  domainEvents.emit({
    type: 'payment.received',
    payload: {
      paymentId: result.paymentId,
      invoiceId,
      workspaceId: workspace.id,
      amount: data.amount,
    },
  });

  return { success: true };
}
