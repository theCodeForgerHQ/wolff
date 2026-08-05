import 'dotenv/config';
import { faker } from '@faker-js/faker';
import Decimal from 'decimal.js';
import { createPrisma } from '../src/client';

/**
 * Deterministic demo seed for Phase 3.
 * Run with: pnpm --filter @wolff/database seed:demo
 *
 * Creates:
 * - Workspace "Kaveri Studio" (Chennai, GSTIN 33..., INR, Razorpay test)
 *   - 40 leads, 25 deals across stages, 30 quotes, 45 invoices
 *   - mix of intra-state TN, inter-state KA/MH, 1 export USD
 *   - payments, 6 overdue in each ageing bucket, 3 contracts
 * - Workspace "Northlight Design" (US, Stripe test)
 */

const prisma = createPrisma();

// Deterministic seed for reproducible demo data.
faker.seed(42_000);

const INDIA_STATES = [
  { code: '33', name: 'Tamil Nadu', city: 'Chennai' },
  { code: '29', name: 'Karnataka', city: 'Bengaluru' },
  { code: '27', name: 'Maharashtra', city: 'Mumbai' },
];

const GST_RATES = [0, 5, 12, 18, 28];

function gstinForState(stateCode: string, pan: string) {
  // 15-char GSTIN: state(2) + PAN(10) + entity(1) + 'Z' + checksum(1)
  return `${stateCode}${pan}1Z${faker.string.numeric(1)}`;
}

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(faker.number.float({ min: 0, max: 0.999 }) * arr.length)]!;
}

function computeGstLines(lines: { amount: Decimal; gstRate: number; stateCode: string }[]) {
  return lines.map((line) => {
    const taxableValue = line.amount;
    const tax = taxableValue.mul(line.gstRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const isIntra = line.stateCode === '33';
    const cgst = isIntra ? tax.div(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : new Decimal(0);
    const sgst = isIntra ? tax.minus(cgst) : new Decimal(0);
    const igst = isIntra ? new Decimal(0) : tax;
    return {
      taxableValue,
      cgst,
      sgst,
      igst,
      tax,
    };
  });
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('seed-demo.ts is for development/demo only.');
    process.exit(1);
  }

  console.log('Seeding demo workspaces...');

  // Clean up previous demo run.
  await prisma.$transaction([
    prisma.dealActivity.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.deal.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.stage.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.pipeline.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.lead.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.contract.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.payment.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.invoiceLineItem.deleteMany({
      where: { invoice: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } } },
    }),
    prisma.invoice.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.quoteLineItem.deleteMany({
      where: { quote: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } } },
    }),
    prisma.quote.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.client.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.paymentSettings.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.businessProfile.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.workspaceMember.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.apiKey.deleteMany({
      where: { workspace: { slug: { in: ['kaveri-studio', 'northlight-design'] } } },
    }),
    prisma.workspace.deleteMany({
      where: { slug: { in: ['kaveri-studio', 'northlight-design'] } },
    }),
  ]);

  // Owner user shared by both workspaces.
  const owner = await prisma.user.upsert({
    where: { email: 'demo@wolff.dev' },
    update: {},
    create: {
      email: 'demo@wolff.dev',
      name: 'Demo Owner',
      emailVerifiedAt: new Date(),
    },
  });

  // ---------------- Kaveri Studio (India / GST / Razorpay) ----------------
  const kaveri = await prisma.workspace.create({
    data: {
      name: 'Kaveri Studio',
      slug: 'kaveri-studio',
      ownerId: owner.id,
      businessProfile: {
        create: {
          businessName: 'Kaveri Studio',
          legalName: 'Kaveri Studio Pvt Ltd',
          gstin: '33AABCU9603R1ZX',
          stateCode: '33',
          pan: 'AABCU9603R',
          gstRegistrationType: 'regular',
          aggregateTurnoverBand: 'le_5cr',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
          locale: 'en-IN',
          address: {
            line1: '12, Cathedral Road',
            city: 'Chennai',
            state: 'Tamil Nadu',
            postalCode: '600086',
            country: 'IN',
          },
        },
      },
      paymentSettings: {
        create: {
          activeProviders: ['razorpay'],
          defaultProviderByCurrency: { INR: 'razorpay' },
          razorpayKeyId: 'rzp_test_kaveri',
          razorpayKeySecretEnc: 'enc:demo',
          razorpayWebhookSecretEnc: 'rzp_demo_secret',
          razorpayVerifiedAt: new Date(),
        },
      },
    },
  });

  const kaveriPipeline = await prisma.pipeline.create({
    data: {
      workspaceId: kaveri.id,
      name: 'Sales Pipeline',
      isDefault: true,
      stages: {
        create: [
          { workspaceId: kaveri.id, name: 'New', position: 0, probability: 10, kind: 'open' },
          { workspaceId: kaveri.id, name: 'Qualified', position: 1, probability: 25, kind: 'open' },
          { workspaceId: kaveri.id, name: 'Proposal', position: 2, probability: 50, kind: 'open' },
          {
            workspaceId: kaveri.id,
            name: 'Negotiation',
            position: 3,
            probability: 75,
            kind: 'open',
          },
          { workspaceId: kaveri.id, name: 'Won', position: 4, probability: 100, kind: 'won' },
          { workspaceId: kaveri.id, name: 'Lost', position: 5, probability: 0, kind: 'lost' },
        ],
      },
    },
    include: { stages: true },
  });

  // 40 leads
  const leadStatuses = ['new', 'contacted', 'qualified', 'disqualified', 'converted'] as const;
  const leadSources = ['manual', 'widget', 'api', 'import'] as const;
  const kaveriLeads = await Promise.all(
    Array.from({ length: 40 }).map((_, i) =>
      prisma.lead.create({
        data: {
          workspaceId: kaveri.id,
          name: faker.person.fullName(),
          email: `kaveri-lead-${i}@example.test`,
          phone: faker.phone.number(),
          company: faker.company.name(),
          status: randomItem(leadStatuses),
          source: randomItem(leadSources),
          score: faker.number.int({ min: 0, max: 100 }),
        },
      })
    )
  );

  // 25 deals
  const kaveriDeals = await Promise.all(
    Array.from({ length: 25 }).map((_, i) => {
      const stage = randomItem(kaveriPipeline.stages);
      const lead = i < kaveriLeads.length ? kaveriLeads[i] : null;
      return prisma.deal.create({
        data: {
          workspaceId: kaveri.id,
          pipelineId: kaveriPipeline.id,
          stageId: stage.id,
          leadId: lead?.id,
          title: faker.commerce.productName(),
          value: faker.number.int({ min: 10_000, max: 500_000 }),
          currency: 'INR',
          expectedCloseDate: faker.date.future({ years: 0.5 }),
          ...(stage.kind === 'won' ? { wonAt: faker.date.recent({ days: 30 }) } : {}),
          ...(stage.kind === 'lost' ? { lostAt: faker.date.recent({ days: 30 }) } : {}),
        },
      });
    })
  );

  // Clients for invoices/quotes.
  const kaveriClients = await Promise.all(
    Array.from({ length: 12 }).map((_, i) => {
      const state = randomItem(INDIA_STATES);
      const isExport = i === 0; // one export client
      return prisma.client.create({
        data: {
          workspaceId: kaveri.id,
          name: faker.company.name(),
          email: `kaveri-client-${i}@example.test`,
          phone: faker.phone.number(),
          countryCode: isExport ? 'US' : 'IN',
          stateCode: isExport ? null : state.code,
          gstin: isExport
            ? null
            : gstinForState(state.code, faker.string.alphanumeric(10).toUpperCase()),
          isGstRegistered: !isExport,
          billingAddress: {
            line1: faker.location.streetAddress(),
            city: isExport ? faker.location.city() : state.city,
            state: isExport ? faker.location.state() : state.name,
            country: isExport ? 'US' : 'IN',
          },
        },
      });
    })
  );

  // 30 quotes
  const kaveriQuotes = await Promise.all(
    Array.from({ length: 30 }).map((_, i) => {
      const client = randomItem(kaveriClients);
      const state = INDIA_STATES.find((s) => s.code === client.stateCode) ?? INDIA_STATES[0]!;
      const lines = Array.from({ length: faker.number.int({ min: 1, max: 3 }) }).map(() => {
        const amount = new Decimal(faker.number.int({ min: 1000, max: 50_000 }));
        const gstRate = randomItem(GST_RATES);
        return { amount, gstRate, stateCode: state.code };
      });
      const computed = computeGstLines(lines);
      const subtotal = computed.reduce((sum, l) => sum.plus(l.taxableValue), new Decimal(0));
      const taxTotal = computed.reduce((sum, l) => sum.plus(l.tax), new Decimal(0));
      return prisma.quote.create({
        data: {
          workspaceId: kaveri.id,
          clientId: client.id,
          quoteNumber: `Q-KS-${String(i + 1).padStart(3, '0')}`,
          status: randomItem(['draft', 'sent', 'accepted'] as const),
          issueDate: faker.date.past({ years: 0.5 }),
          expirationDate: faker.date.future({ years: 0.25 }),
          subtotal,
          taxTotal,
          total: subtotal.plus(taxTotal),
          currency: client.countryCode === 'US' ? 'USD' : 'INR',
          lineItems: {
            create: lines.map((line, idx) => ({
              name: faker.commerce.product(),
              description: faker.commerce.productDescription(),
              quantity: 1,
              rate: line.amount,
              amount: line.amount,
              taxRate: line.gstRate,
              taxAmount: computed[idx]!.tax,
              gstRate: line.gstRate,
              hsnSac: faker.string.numeric(4),
            })),
          },
        },
      });
    })
  );

  // 45 invoices with mix of statuses and ageing buckets.
  const ageingTargets = {
    current: 6,
    bucket_0_30: 6,
    bucket_31_60: 6,
    bucket_61_90: 6,
    bucket_90_plus: 6,
  };
  let ageingCounts = {
    current: 0,
    bucket_0_30: 0,
    bucket_31_60: 0,
    bucket_61_90: 0,
    bucket_90_plus: 0,
  };

  const kaveriInvoices = await Promise.all(
    Array.from({ length: 45 }).map(async (_, i) => {
      const client = randomItem(kaveriClients);
      const state = INDIA_STATES.find((s) => s.code === client.stateCode) ?? INDIA_STATES[0]!;
      const isExport = client.countryCode === 'US';
      const lines = Array.from({ length: faker.number.int({ min: 1, max: 3 }) }).map(() => {
        const amount = new Decimal(faker.number.int({ min: 1000, max: 50_000 }));
        const gstRate = isExport ? 0 : randomItem(GST_RATES);
        return { amount, gstRate, stateCode: state.code };
      });
      const computed = computeGstLines(lines);
      const subtotal = computed.reduce((sum, l) => sum.plus(l.taxableValue), new Decimal(0));
      const taxTotal = computed.reduce((sum, l) => sum.plus(l.tax), new Decimal(0));
      const total = subtotal.plus(taxTotal);

      // Distribute statuses and ensure 6 per ageing bucket for overdue/sent.
      let status: 'draft' | 'sent' | 'paid' | 'partial' | 'overdue' = 'sent';
      let dueDate = faker.date.recent({ days: 120 });
      let paidAt: Date | null = null;
      let amountPaid = new Decimal(0);

      if (i < 5) status = 'draft';
      else if (i < 20) {
        status = 'paid';
        paidAt = faker.date.recent({ days: 60 });
        amountPaid = total;
      } else if (i < 30) {
        status = 'partial';
        amountPaid = total.mul(0.5).toDecimalPlaces(2);
      } else {
        // Force 6 per bucket.
        const bucket = Object.entries(ageingTargets).find(
          ([_, target]) => ageingCounts[_ as keyof typeof ageingCounts] < target
        )![0] as keyof typeof ageingCounts;
        const days =
          bucket === 'current'
            ? -faker.number.int({ min: 0, max: 5 })
            : bucket === 'bucket_0_30'
              ? faker.number.int({ min: 1, max: 30 })
              : bucket === 'bucket_31_60'
                ? faker.number.int({ min: 31, max: 60 })
                : bucket === 'bucket_61_90'
                  ? faker.number.int({ min: 61, max: 90 })
                  : faker.number.int({ min: 91, max: 180 });
        dueDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        status = days <= 0 ? 'sent' : 'overdue';
        ageingCounts[bucket]++;
      }

      const invoice = await prisma.invoice.create({
        data: {
          workspaceId: kaveri.id,
          clientId: client.id,
          quoteId: i < kaveriQuotes.length ? kaveriQuotes[i]!.id : null,
          invoiceNumber: `INV-KS-${String(i + 1).padStart(3, '0')}`,
          status,
          issueDate: faker.date.past({ years: 0.5 }),
          dueDate,
          subtotal,
          taxTotal,
          total,
          amountPaid,
          amountDue: total.minus(amountPaid),
          currency: isExport ? 'USD' : 'INR',
          paidAt,
          placeOfSupply: state.code,
          supplyType: isExport ? 'export' : state.code === '33' ? 'intra' : 'inter',
          supplierGstin: '33AABCU9603R1ZX',
          recipientGstin: client.gstin,
          lineItems: {
            create: lines.map((line, idx) => ({
              name: faker.commerce.product(),
              description: faker.commerce.productDescription(),
              quantity: 1,
              rate: line.amount,
              amount: line.amount,
              gstRate: line.gstRate,
              taxableValue: line.amount,
              cgstRate: line.stateCode === '33' ? line.gstRate / 2 : 0,
              cgstAmount: computed[idx]!.cgst,
              sgstRate: line.stateCode === '33' ? line.gstRate / 2 : 0,
              sgstAmount: computed[idx]!.sgst,
              igstRate: line.stateCode === '33' ? 0 : line.gstRate,
              igstAmount: computed[idx]!.igst,
            })),
          },
        },
      });

      // Create a payment for paid/partial invoices.
      if (status === 'paid' || status === 'partial') {
        await prisma.payment.create({
          data: {
            workspaceId: kaveri.id,
            invoiceId: invoice.id,
            amount: amountPaid,
            currency: invoice.currency,
            paymentMethod: randomItem(['upi', 'card', 'netbanking']),
            status: 'completed',
            provider: 'razorpay',
            processedAt: paidAt ?? faker.date.recent({ days: 30 }),
          },
        });
      }

      return invoice;
    })
  );

  // 3 contracts
  await Promise.all(
    Array.from({ length: 3 }).map((_, i) =>
      prisma.contract.create({
        data: {
          workspaceId: kaveri.id,
          name: `Service Agreement ${i + 1}`,
          content: faker.lorem.paragraphs(5),
          isTemplate: false,
          variables: [{ name: 'client_name', type: 'string' }],
        },
      })
    )
  );

  // ---------------- Northlight Design (US / Stripe) ----------------
  const northlight = await prisma.workspace.create({
    data: {
      name: 'Northlight Design',
      slug: 'northlight-design',
      ownerId: owner.id,
      businessProfile: {
        create: {
          businessName: 'Northlight Design LLC',
          currency: 'USD',
          timezone: 'America/New_York',
          locale: 'en-US',
          address: {
            line1: faker.location.streetAddress(),
            city: faker.location.city(),
            state: faker.location.state(),
            postalCode: faker.location.zipCode(),
            country: 'US',
          },
        },
      },
      paymentSettings: {
        create: {
          activeProviders: ['stripe'],
          defaultProviderByCurrency: { '*': 'stripe' },
          stripeAccountId: 'acct_demo_northlight',
          stripeAccountStatus: 'active',
          stripeOnboardingComplete: true,
          chargesEnabled: true,
          payoutsEnabled: true,
        },
      },
    },
  });

  const northlightClient = await prisma.client.create({
    data: {
      workspaceId: northlight.id,
      name: faker.company.name(),
      email: 'northlight-client@example.test',
      countryCode: 'US',
      isGstRegistered: false,
    },
  });

  await prisma.invoice.create({
    data: {
      workspaceId: northlight.id,
      clientId: northlightClient.id,
      invoiceNumber: 'INV-NL-001',
      status: 'paid',
      issueDate: faker.date.past({ years: 0.25 }),
      dueDate: faker.date.future({ years: 0.25 }),
      subtotal: 2000,
      taxTotal: 0,
      total: 2000,
      amountPaid: 2000,
      amountDue: 0,
      currency: 'USD',
      paidAt: faker.date.recent({ days: 15 }),
      lineItems: {
        create: {
          name: 'Brand Design',
          description: 'Brand identity package',
          quantity: 1,
          rate: 2000,
          amount: 2000,
          taxableValue: 2000,
        },
      },
    },
  });

  console.log('Demo seed complete:');
  console.log(
    `  Kaveri Studio: ${kaveriLeads.length} leads, ${kaveriDeals.length} deals, ${kaveriQuotes.length} quotes, ${kaveriInvoices.length} invoices`
  );
  console.log(`  Northlight Design: 1 invoice`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
