# Stripe upgrade: SDK 17 → 22, API `2025-02-24.acacia` → `2026-08-26.dahlia`

Phase 1. The SDK is pinned to `stripe@22.6.2`, whose pinned API
version is `2026-08-26.dahlia`; `lib/services/stripe.ts` sets the same value
explicitly (`STRIPE_API_VERSION`). The client libraries (`@stripe/stripe-js` 8,
`@stripe/react-stripe-js` 5) are unchanged in this phase.

## What Wolff calls

| Area           | Calls                                                                                                                                                                                      | Where                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| PaymentIntents | `create` (destination charge: `transfer_data.destination`, `automatic_payment_methods`, idempotency key), `retrieve`, `cancel`; reads `status`, `amount`, `client_secret`, `latest_charge` | `lib/services/stripe.ts`, `lib/payments/internal.ts` |
| Charges        | reads `payment_intent` on `charge.refunded`                                                                                                                                                | `app/api/webhooks/stripe/route.ts`                   |
| Refunds        | `create` (payment_intent, amount, reason)                                                                                                                                                  | `lib/services/stripe.ts`                             |
| Customers      | `list` by email, `create`                                                                                                                                                                  | `lib/services/stripe.ts`                             |
| Checkout       | `sessions.create` (`mode: payment`, `payment_method_types: ['card']`, `price_data`)                                                                                                        | `lib/providers/stripe-provider.ts`                   |
| Connect        | `accounts.create` (standard), `accounts.retrieve`, `accountLinks.create`                                                                                                                   | `lib/payments/actions.ts`                            |
| Webhooks       | `webhooks.constructEvent`; `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `account.updated`                                                               | webhook route, provider                              |
| Stripe.js      | `PaymentElement` + `confirmPayment`                                                                                                                                                        | `components/client-portal/payment-form.tsx`          |

## API changelog, major by major

Sources: the Stripe changelog pages for [basil](https://docs.stripe.com/changelog/basil),
[clover](https://docs.stripe.com/changelog/clover) and
[dahlia](https://docs.stripe.com/changelog/dahlia), and the entries linked below.
Only the first release of each major is breaking; the monthly releases that
follow it are additive.

### 2025-03-31.basil

| Change                                                                                                                                                                                                                                                            | Affects Wolff?                                                                                                                                                                                      | Action                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Cancelling or partially capturing a payment no longer creates a refund](https://docs.stripe.com/changelog/basil/2025-03-31/remove-refund-from-partial-capture-and-payment-cancellation-flow): no `charge.refunded` event, `amount_refunded`/`refunded` unchanged | No. Wolff only cancels intents in `requires_payment_method`/`requires_confirmation` (stale amount), which have no charge. Refunds go through `refunds.create`, which still emits `charge.refunded`. | none                                                                         |
| [`total_count` can no longer be expanded on lists](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-total-count-expansion)                                                                                                                            | No. `customers.list` doesn't expand it.                                                                                                                                                             | none                                                                         |
| [Payment Element default layout is `accordion` instead of `tabs`](https://docs.stripe.com/changelog/basil/2025-03-31/default-layout-of-payment-element)                                                                                                           | Yes, visually.                                                                                                                                                                                      | `PaymentElement` now passes `layout: 'tabs'` to keep the existing portal UI. |
| Checkout Session shipping and subscription changes                                                                                                                                                                                                                | No. Payment mode, no shipping.                                                                                                                                                                      | none                                                                         |

### 2025-09-30.clover

| Change                                                                                                                                                                                     | Affects Wolff?                                                                                                                                            | Action |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| [Elements rejects client secrets of intents that are `succeeded`, `canceled`, `processing` or `requires_capture`](https://docs.stripe.com/changelog/clover/2025-09-30/client-secret-reuse) | No. `lib/payments/internal.ts` only reuses an intent in `requires_payment_method` or `requires_confirmation`; terminal intents are recorded and replaced. | none   |
| [Postal code no longer collected for cards in CA/UK/PR](https://docs.stripe.com/changelog/clover/2025-09-30/postal_code_in_card_form_for_non_us_countries)                                 | No. Wolff doesn't read billing postal codes.                                                                                                              | none   |
| `redirectToCheckout` and legacy Elements removed                                                                                                                                           | No. Checkout redirects to `session.url`.                                                                                                                  | none   |

### 2026-03-25.dahlia (current: 2026-08-26.dahlia)

| Change                                                                                                                                                                                                         | Affects Wolff?                                                                                                                            | Action                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| [Checkout `ui_mode` values renamed](https://docs.stripe.com/changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes) (`hosted` → `hosted_page`, …)                                             | No. `ui_mode` isn't set; the default is the hosted page.                                                                                  | none                        |
| [Legacy Stripe.js methods removed](https://docs.stripe.com/changelog/dahlia/2026-03-25/remove-legacy-stripejs-methods) (`handleCardPayment`, `createSource`, …)                                                | No. Wolff uses `confirmPayment`.                                                                                                          | none                        |
| Connect risk requirements added to capabilities                                                                                                                                                                | No (additive). `account.updated` still maps `charges_enabled`, `payouts_enabled`, `details_submitted`.                                    | none                        |
| [`payment_method_types` removed from PaymentIntents](https://docs.stripe.com/changelog/dahlia/2026-08-26/removes-payment-method-types-parameter-from-payment-intents-setup-intents), **preview versions only** | Not today: intents use `automatic_payment_methods`. Checkout still sends `payment_method_types: ['card']`, which is a different endpoint. | Watch for this reaching GA. |

## SDK (stripe-node) majors

| Major | Breaking change                                                                                                                                                                                          | Affects Wolff?                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 18    | Pins basil                                                                                                                                                                                               | covered above                                                                                                                                                                              |
| 19    | `parseThinEvent` → `parseEventNotification`; Node < 16 dropped                                                                                                                                           | No                                                                                                                                                                                         |
| 20    | v2 event list parameters                                                                                                                                                                                 | No                                                                                                                                                                                         |
| 21    | Pins dahlia; `decimal_string` fields become `Stripe.Decimal`; the wrong webhook parser now throws; Node 18 minimum                                                                                       | No. `unit_amount` (integer) is used, not `unit_amount_decimal`; snapshot events use `constructEvent`.                                                                                      |
| 22    | `Stripe` is an ES6 class (`new Stripe()` required); `Stripe.errors.StripeError` is no longer usable as a type; options-only calls need `undefined` params; per-request `host` removed; callbacks removed | No. Wolff already uses `new Stripe(key, opts)`, passes options second and never annotates `Stripe.errors.StripeError`. The only compile error after the bump was the `apiVersion` literal. |

## How it was tested (no Stripe keys available)

- `__tests__/lib/services/stripe-webhook-signature.test.ts` (always runs): the
  real SDK verifies payloads signed with `Stripe.webhooks.generateTestHeaderString`
  and rejects tampered bodies, wrong secrets and stale timestamps.
- `__tests__/lib/services/stripe-mock.contract.test.ts` (runs when
  `STRIPE_MOCK_URL` is set; CI starts `stripe/stripe-mock`): the service
  functions in `lib/services/stripe.ts`, the only module that holds the client,
  create a destination-charge PaymentIntent, retrieve and cancel one, look up
  a customer, refund, and create a Checkout Session, a Connect account and its
  onboarding link. stripe-mock validates each request against
  Stripe's OpenAPI spec (0.205.0 was used locally; it can lag the newest API
  version by a few releases).
- The Playwright payment flow runs the app against stripe-mock through
  `STRIPE_API_BASE_URL` and delivers a signed `payment_intent.succeeded` webhook
  to mark the invoice paid (see `docs/phase-1.md`).

## Still needs a human with a Stripe test account

- Set the webhook endpoints' API version in the Stripe Dashboard to
  `2026-08-26.dahlia` when this ships: events are rendered with the endpoint's
  version, not the SDK's.
- Re-run Connect onboarding, a test-mode card payment through the Payment
  Element (now pinned to `tabs`) and a refund with real test keys.
- Wolff creates **standard** Connect accounts but charges with
  `transfer_data.destination` (a destination charge). Stripe recommends direct
  charges for standard accounts. This predates the upgrade and is noted for the
  Phase 3 `PaymentProvider` work.
