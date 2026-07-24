/**
 * Creates a user together with the workspace they own.
 *
 * Every signed-in page resolves a workspace through the user's membership
 * (`getCurrentUserWorkspace`), so a user without one can't load anything,
 * onboarding included. Both ways of creating a user go through here: the
 * register route (credentials) and the Auth.js adapter (first OAuth sign-in).
 */
import type { PrismaClient } from '@wolff/database';

// Slugs that would collide with top-level routes.
const RESERVED_SLUGS = new Set([
  'api',
  'admin',
  'auth',
  'login',
  'register',
  'settings',
  'dashboard',
  'onboarding',
  'quotes',
  'invoices',
  'clients',
  'projects',
  'analytics',
  'help',
  'templates',
  'contracts',
  'rate-cards',
  'q',
  'i',
  'p',
  'c',
  'invite',
  'verify-email',
  'reset-password',
  'forgot-password',
  'public',
  'static',
  'assets',
  '_next',
]);

const SLUG_SUFFIX_LENGTH = 8;
const FALLBACK_SLUG = 'workspace';

export function generateWorkspaceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const base = RESERVED_SLUGS.has(slug) ? `ws-${slug}` : slug || FALLBACK_SLUG;
  return `${base}-${crypto.randomUUID().substring(0, SLUG_SUFFIX_LENGTH)}`;
}

/** OAuth providers don't always send a name; fall back to the mailbox name. */
function displayName(name: string | null | undefined, email: string): string {
  return name?.trim() || email.split('@')[0] || email;
}

export interface NewUserInput {
  email: string;
  name?: string | null;
  passwordHash?: string;
  avatarUrl?: string | null;
  emailVerifiedAt?: Date | null;
}

export interface ProvisionedUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  emailVerifiedAt: true,
} as const;

/**
 * One transaction: the user, their workspace and the owner membership either
 * all exist or none do.
 */
export async function createUserWithWorkspace(
  prisma: PrismaClient,
  input: NewUserInput
): Promise<ProvisionedUser> {
  const email = input.email.toLowerCase();
  const workspaceOwner = displayName(input.name, email);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        name: input.name ?? null,
        ...(input.passwordHash !== undefined && { passwordHash: input.passwordHash }),
        ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
        ...(input.emailVerifiedAt !== undefined && { emailVerifiedAt: input.emailVerifiedAt }),
      },
      select: USER_SELECT,
    });

    const workspace = await tx.workspace.create({
      data: {
        name: `${workspaceOwner}'s Workspace`,
        slug: generateWorkspaceSlug(workspaceOwner),
        ownerId: user.id,
        settings: { onboardingCompleted: false },
      },
    });

    await tx.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        role: 'owner',
        acceptedAt: new Date(),
      },
    });

    return user;
  });
}
