import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma } from '@wolff/database';
import { applyStripeEvent } from './apply-stripe-event';

const url = process.env.TEST_DATABASE_URL;

/**
 * applyStripeEvent against Postgres, one fresh invoice (total 100.00) and
 * pending payment per test. The webhook route and outbox are tested in the
 * api package; these pin the money rules themselves.
 */
describe.skipIf(!url)('Stripe event application (Postgres)', () => {
  const base = createPrisma(url);
  const run = randomUUID().replace(/-/g, '').slice(0, 12);
  let workspaceId = '';
  let clientId = '';
  let n = 0;

  const apply = (payload: unknown) => base.$transaction((tx) => applyStripeEvent(tx, payload));
  const event = (type: string, object: Record<string, unknown>) => ({ type, data: { object } });

  /** An invoice of 100.00 with one pending payment of `amount`. */
  async function pending(
    amount = 100,
    link: { intent?: string; session?: string } = {},
    currency = 'usd'
  ) {
    const i = ++n;
    const intent = link.intent ?? (link.session ? undefined : `pi_${run}_${i}`);
    const invoice = await base.invoice.create({
      data: {
        workspaceId,
        clientId,
        invoiceNumber: `ST-${run}-${i}`,
        status: 'sent',
        subtotal: 100,
        total: 100,
        amountDue: 100,
        dueDate: new Date('2026-12-01'),
      },
    });
    const payment = await base.payment.create({
      data: {
        invoiceId: invoice.id,
        workspaceId,
        amount,
        currency,
        paymentMethod: 'card',
        status: 'pending',
        provider: 'stripe',
        stripePaymentIntentId: intent,
        providerOrderId: link.session,
      },
    });
    return { invoiceId: invoice.id, paymentId: payment.id, intent: intent! };
  }

  const state = async (invoiceId: string) => {
    const invoice = await base.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true, events: true },
    });
    return {
      status: invoice.status,
      amountPaid: Number(invoice.amountPaid),
      amountDue: Number(invoice.amountDue),
      paidAt: invoice.paidAt,
      payment: invoice.payments[0]!,
      events: invoice.events.map((e) => e.eventType),
    };
  };
  const outbox = (aggregateId: string) =>
    base.outboxEvent.findMany({ where: { aggregateId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    const workspace = await base.workspace.create({
      data: {
        name: 'Stripe Events',
        slug: `stripe-events-${run}`,
        clients: { create: { name: 'Client', email: `client-${run}@example.test` } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;
    clientId = workspace.clients[0]!.id;
  });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({ where: { workspaceId } });
    await base.payment.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  describe('payment_intent.succeeded', () => {
    it('credits the invoice once, marks it paid and writes the outbox events', async () => {
      const { invoiceId, paymentId, intent } = await pending();
      const succeeded = event('payment_intent.succeeded', {
        id: intent,
        latest_charge: { id: 'ch_1', receipt_url: 'https://pay.stripe.test/r/1' },
      });

      await apply(succeeded);
      await apply(succeeded);

      const after = await state(invoiceId);
      expect(after).toMatchObject({ status: 'paid', amountPaid: 100, amountDue: 0 });
      expect(after.paidAt).not.toBeNull();
      expect(after.payment).toMatchObject({
        status: 'completed',
        stripeChargeId: 'ch_1',
        stripeReceiptUrl: 'https://pay.stripe.test/r/1',
      });
      expect(after.events.filter((e) => e === 'payment_received')).toHaveLength(1);
      expect((await outbox(paymentId)).map((e) => e.type)).toEqual([
        'payment.received',
        'email.payment_received',
      ]);
      expect((await outbox(invoiceId)).map((e) => e.type)).toEqual(['invoice.paid']);
    });

    it('takes a charge given as an id string', async () => {
      const { invoiceId, intent } = await pending();
      await apply(event('payment_intent.succeeded', { id: intent, latest_charge: 'ch_str' }));
      expect((await state(invoiceId)).payment.stripeChargeId).toBe('ch_str');
    });

    it('marks a part payment partial, with the rest still due, and no invoice.paid', async () => {
      const { invoiceId, intent } = await pending(40);

      await apply(event('payment_intent.succeeded', { id: intent }));

      expect(await state(invoiceId)).toMatchObject({
        status: 'partial',
        amountPaid: 40,
        amountDue: 60,
      });
      expect(await outbox(invoiceId)).toEqual([]);
    });

    it('credits a payment that failed before (the client retried with another card)', async () => {
      const { invoiceId, intent } = await pending();
      await apply(event('payment_intent.payment_failed', { id: intent }));
      expect((await state(invoiceId)).payment.status).toBe('failed');

      await apply(event('payment_intent.succeeded', { id: intent }));

      expect(await state(invoiceId)).toMatchObject({ status: 'paid', amountPaid: 100 });
    });

    it('retries an intent no payment knows yet, and refuses one without an id', async () => {
      // Marking it processed would lose the payment if its row (or the
      // session link) only appears a moment later.
      await expect(apply(event('payment_intent.succeeded', { id: 'pi_unknown' }))).rejects.toThrow(
        /not ready/
      );
      await expect(apply(event('payment_intent.succeeded', {}))).rejects.toThrow(/intent id/);
    });
  });

  describe('crediting guards', () => {
    it('does not credit a voided invoice, and records the payment for a refund', async () => {
      const { invoiceId, intent } = await pending();
      await base.invoice.update({ where: { id: invoiceId }, data: { status: 'voided' } });

      await apply(event('payment_intent.succeeded', { id: intent }));

      const after = await state(invoiceId);
      expect(after).toMatchObject({ status: 'voided', amountPaid: 0 });
      expect(after.payment.status).toBe('completed');
      expect(after.events).toContain('payment_on_closed_invoice');
      expect(after.events).not.toContain('payment_received');
    });

    it('credits no more than is due and records the overpayment', async () => {
      const { invoiceId, intent } = await pending(100);
      await base.invoice.update({
        where: { id: invoiceId },
        data: { status: 'partial', amountPaid: 80, amountDue: 20 },
      });

      await apply(event('payment_intent.succeeded', { id: intent }));

      const after = await state(invoiceId);
      expect(after).toMatchObject({ status: 'paid', amountPaid: 100, amountDue: 0 });
      expect(after.events).toContain('overpayment');
    });

    it('does not credit an intent whose amount_received differs from the payment', async () => {
      const { invoiceId, intent } = await pending(100);

      await apply(
        event('payment_intent.succeeded', { id: intent, amount_received: 100, currency: 'usd' })
      );

      const after = await state(invoiceId);
      expect(after).toMatchObject({ status: 'sent', amountPaid: 0 });
      expect(after.payment.status).toBe('pending');
      expect(after.events).toContain('payment_mismatch');
    });

    it('credits an intent whose amount_received matches', async () => {
      const { invoiceId, intent } = await pending(100);

      await apply(
        event('payment_intent.succeeded', { id: intent, amount_received: 10_000, currency: 'usd' })
      );

      expect(await state(invoiceId)).toMatchObject({ status: 'paid', amountPaid: 100 });
    });
  });

  describe('payment_intent.payment_failed', () => {
    it('does not undo a credit when a decline arrives late', async () => {
      const { invoiceId, intent } = await pending();
      await apply(event('payment_intent.succeeded', { id: intent }));

      await apply(event('payment_intent.payment_failed', { id: intent }));

      expect(await state(invoiceId)).toMatchObject({ status: 'paid', amountPaid: 100 });
      expect((await state(invoiceId)).payment.status).toBe('completed');
    });

    it('refuses an event without an intent id', async () => {
      await expect(apply(event('payment_intent.payment_failed', {}))).rejects.toThrow();
    });
  });

  describe('checkout sessions', () => {
    const session = (id: string, extra: Record<string, unknown>) =>
      event('checkout.session.completed', { id, currency: 'usd', amount_total: 10_000, ...extra });

    it('links the session to its intent and credits a paid session', async () => {
      const sessionId = `cs_${run}_${n + 1}`;
      const { invoiceId } = await pending(100, { session: sessionId });

      await apply(
        session(sessionId, { payment_intent: 'pi_from_session', payment_status: 'paid' })
      );

      const after = await state(invoiceId);
      expect(after.payment.stripePaymentIntentId).toBe('pi_from_session');
      expect(after).toMatchObject({ status: 'paid', amountPaid: 100 });
    });

    it('links an unpaid (delayed) session without crediting, then credits on the intent', async () => {
      const sessionId = `cs_${run}_${n + 1}`;
      const { invoiceId } = await pending(100, { session: sessionId });

      await apply(
        session(sessionId, { payment_intent: { id: 'pi_delayed' }, payment_status: 'unpaid' })
      );
      expect(await state(invoiceId)).toMatchObject({ status: 'sent', amountPaid: 0 });

      await apply(event('payment_intent.succeeded', { id: 'pi_delayed' }));
      expect(await state(invoiceId)).toMatchObject({ status: 'paid', amountPaid: 100 });
    });

    it('leaves a session that charges a different amount unlinked and records the mismatch', async () => {
      const sessionId = `cs_${run}_${n + 1}`;
      const { invoiceId } = await pending(100, { session: sessionId });

      await apply(
        session(sessionId, {
          payment_intent: 'pi_wrong_amount',
          payment_status: 'paid',
          amount_total: 1,
        })
      );

      const after = await state(invoiceId);
      expect(after.payment.stripePaymentIntentId).toBeNull();
      expect(after).toMatchObject({ status: 'sent', amountPaid: 0 });
      expect(after.events).toContain('payment_mismatch');
      // The intent's own success finds no payment and credits nothing.
      await expect(
        apply(event('payment_intent.succeeded', { id: 'pi_wrong_amount' }))
      ).rejects.toThrow(/not ready/);
      expect((await state(invoiceId)).amountPaid).toBe(0);
    });

    it('matches a zero-decimal (JPY) session in whole yen', async () => {
      const sessionId = `cs_${run}_${n + 1}`;
      const { invoiceId } = await pending(100, { session: sessionId }, 'jpy');

      await apply(
        session(sessionId, {
          payment_intent: `pi_jpy_${run}`,
          payment_status: 'paid',
          currency: 'jpy',
          amount_total: 100,
        })
      );

      const after = await state(invoiceId);
      expect(after.events).not.toContain('payment_mismatch');
      expect(after).toMatchObject({ status: 'paid', amountPaid: 100 });
    });

    it('treats a different currency as a mismatch', async () => {
      const sessionId = `cs_${run}_${n + 1}`;
      const { invoiceId } = await pending(100, { session: sessionId });

      await apply(session(sessionId, { payment_intent: 'pi_eur', currency: 'eur' }));

      expect((await state(invoiceId)).events).toContain('payment_mismatch');
      expect((await state(invoiceId)).payment.stripePaymentIntentId).toBeNull();
    });

    it('does nothing for a session without an intent, and refuses one without an id', async () => {
      await expect(apply(session('cs_none', {}))).resolves.toBeUndefined();
      await expect(apply(event('checkout.session.completed', {}))).rejects.toThrow(/session id/);
    });

    it('closes the pending payment of an expired session, and only a pending one', async () => {
      const sessionId = `cs_${run}_${n + 1}`;
      const { invoiceId } = await pending(100, { session: sessionId });

      await apply(event('checkout.session.expired', { id: sessionId }));

      expect((await state(invoiceId)).payment.status).toBe('failed');
      await expect(apply(event('checkout.session.async_payment_failed', {}))).rejects.toThrow();
    });
  });

  describe('charge.refunded', () => {
    const refunded = (intent: unknown, cents: unknown) =>
      event('charge.refunded', { payment_intent: intent, amount_refunded: cents });

    it('applies a running refund total as differences, so a redelivery changes nothing', async () => {
      const { invoiceId, paymentId, intent } = await pending();
      await apply(event('payment_intent.succeeded', { id: intent }));

      await apply(refunded(intent, 3_000));
      await apply(refunded(intent, 3_000));
      expect(await state(invoiceId)).toMatchObject({
        status: 'partial',
        amountPaid: 70,
        amountDue: 30,
      });
      expect((await state(invoiceId)).payment.status).toBe('completed');

      await apply(refunded({ id: intent }, 10_000));
      const after = await state(invoiceId);
      expect(after).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 100, paidAt: null });
      expect(after.payment.status).toBe('refunded');
      expect(Number(after.payment.refundAmount)).toBe(100);
      expect(after.events.filter((e) => e === 'payment_refunded')).toHaveLength(2);
      expect((await outbox(paymentId)).filter((e) => e.type === 'payment.refunded')).toHaveLength(
        2
      );
    });

    it('reads a zero-decimal (JPY) refund total in whole yen', async () => {
      const { invoiceId, intent } = await pending(100, {}, 'jpy');
      await apply(event('payment_intent.succeeded', { id: intent }));

      await apply(refunded(intent, 40));

      const after = await state(invoiceId);
      expect(Number(after.payment.refundAmount)).toBe(40);
      expect(after).toMatchObject({ status: 'partial', amountPaid: 60, amountDue: 40 });
    });

    it('ignores a smaller running total arriving out of order', async () => {
      const { invoiceId, intent } = await pending();
      await apply(event('payment_intent.succeeded', { id: intent }));
      await apply(refunded(intent, 5_000));

      await apply(refunded(intent, 2_000));

      expect((await state(invoiceId)).amountPaid).toBe(50);
    });

    it('retries a refund that arrives before the payment was credited', async () => {
      const { invoiceId, intent } = await pending();

      await expect(apply(refunded(intent, 10_000))).rejects.toThrow(/not ready/);
      expect((await state(invoiceId)).payment.status).toBe('pending');

      // Once the success has been applied, the retried refund lands.
      await apply(event('payment_intent.succeeded', { id: intent }));
      await apply(refunded(intent, 10_000));
      expect(await state(invoiceId)).toMatchObject({ status: 'sent', amountPaid: 0 });
    });

    it('retries a refund of a charge no payment knows yet', async () => {
      await expect(apply(refunded('pi_refund_unknown', 100))).rejects.toThrow(/not ready/);
    });

    it.each([[-1], [1.5], ['100'], [undefined]])(
      'refuses an amount_refunded of %s',
      async (cents) => {
        await expect(apply(refunded('pi_any', cents))).rejects.toThrow(/amount_refunded/);
      }
    );

    it('ignores a refund of a charge without an intent', async () => {
      await expect(apply(refunded(undefined, 100))).resolves.toBeUndefined();
    });
  });

  describe('account.updated', () => {
    async function settings(accountId: string) {
      const ws = await base.workspace.create({
        data: {
          name: 'Connect',
          slug: `connect-${run}-${++n}`,
          paymentSettings: { create: { stripeAccountId: accountId } },
        },
      });
      return ws.id;
    }
    const read = (id: string) =>
      base.paymentSettings.findUniqueOrThrow({ where: { workspaceId: id } });

    it.each([
      [{ charges_enabled: true, payouts_enabled: true }, 'active', true],
      [{ charges_enabled: true, requirements: { past_due: ['x'] } }, 'past_due', false],
      [{ requirements: { currently_due: ['x'], past_due: [] } }, 'incomplete', false],
      [{}, 'pending', false],
    ])('mirrors %j as %s', async (account, status, complete) => {
      const accountId = `acct_${run}_${n + 1}`;
      const id = await settings(accountId);
      try {
        await apply(event('account.updated', { id: accountId, ...account }));
        expect(await read(id)).toMatchObject({
          stripeAccountStatus: status,
          stripeOnboardingComplete: complete,
        });
      } finally {
        await base.workspace.delete({ where: { id } });
      }
    });

    it('ignores an unknown account and an event type it does not act on', async () => {
      await expect(apply(event('account.updated', { id: 'acct_nobody' }))).resolves.toBeUndefined();
      await expect(apply(event('account.updated', {}))).resolves.toBeUndefined();
      await expect(apply(event('customer.created', { id: 'cus_1' }))).resolves.toBeUndefined();
      await expect(apply(null)).resolves.toBeUndefined();
    });
  });
});
