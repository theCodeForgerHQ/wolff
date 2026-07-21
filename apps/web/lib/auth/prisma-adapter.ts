/**
 * Auth.js adapter for Wolff's Prisma schema.
 *
 * `@auth/prisma-adapter` assumes the Auth.js reference schema (`emailVerified`,
 * `image`, snake_case account token columns, `expires`). Wolff's models use
 * `emailVerifiedAt`, `avatarUrl`, camelCase account fields and `expiresAt`, so
 * the stock adapter's `createUser` and `linkAccount` fail Prisma validation and
 * a first-time Google or GitHub sign-in could never complete. This adapter
 * maps between the two shapes explicitly.
 *
 * Sessions are JWTs (`lib/auth/index.ts`), so Auth.js only calls the user and
 * account methods in practice; the session and verification-token methods are
 * implemented so the adapter stays complete if the strategy changes.
 */
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from 'next-auth/adapters';
import type { Account, PrismaClient, Session, User } from '@wolff/database';

type DbUser = Pick<User, 'id' | 'email' | 'name' | 'avatarUrl' | 'emailVerifiedAt'>;

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  emailVerifiedAt: true,
} as const;

export function toAdapterUser(user: DbUser): AdapterUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    image: user.avatarUrl,
    emailVerified: user.emailVerifiedAt,
  };
}

function toUserData(user: Partial<AdapterUser>) {
  return {
    ...(user.email !== undefined && { email: user.email.toLowerCase() }),
    ...(user.name !== undefined && { name: user.name }),
    ...((user.avatarUrl !== undefined || user.image !== undefined) && {
      avatarUrl: user.avatarUrl ?? user.image ?? null,
    }),
    ...(user.emailVerified !== undefined && { emailVerifiedAt: user.emailVerified }),
  };
}

export function toAccountData(account: AdapterAccount) {
  return {
    userId: account.userId,
    type: account.type,
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    accessToken: account.access_token ?? null,
    refreshToken: account.refresh_token ?? null,
    expiresAt: account.expires_at ?? null,
    tokenType: account.token_type ?? null,
    scope: account.scope ?? null,
    idToken: account.id_token ?? null,
    sessionState: typeof account.session_state === 'string' ? account.session_state : null,
  };
}

export function toAdapterAccount(account: Account): AdapterAccount {
  return {
    userId: account.userId,
    type: account.type as AdapterAccount['type'],
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    access_token: account.accessToken ?? undefined,
    refresh_token: account.refreshToken ?? undefined,
    expires_at: account.expiresAt ?? undefined,
    token_type: (account.tokenType as AdapterAccount['token_type']) ?? undefined,
    scope: account.scope ?? undefined,
    id_token: account.idToken ?? undefined,
    session_state: account.sessionState ?? undefined,
  };
}

function toAdapterSession(session: Session): AdapterSession {
  return {
    sessionToken: session.sessionToken,
    userId: session.userId,
    expires: session.expiresAt,
  };
}

/** Prisma "record not found" on update/delete. */
function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2025';
}

export function WolffPrismaAdapter(prisma: PrismaClient): Adapter {
  return {
    async createUser({ id: _id, ...user }) {
      // Let the database generate the UUID; Auth.js proposes its own id.
      const created = await prisma.user.create({
        data: { email: user.email.toLowerCase(), ...toUserData(user) },
        select: USER_SELECT,
      });
      return toAdapterUser(created);
    },

    async getUser(id) {
      const user = await prisma.user.findFirst({
        where: { id, deletedAt: null },
        select: USER_SELECT,
      });
      return user ? toAdapterUser(user) : null;
    },

    async getUserByEmail(email) {
      const user = await prisma.user.findFirst({
        where: { email: email.toLowerCase(), deletedAt: null },
        select: USER_SELECT,
      });
      return user ? toAdapterUser(user) : null;
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const account = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
        select: { user: { select: { ...USER_SELECT, deletedAt: true } } },
      });
      if (!account || account.user.deletedAt) return null;
      return toAdapterUser(account.user);
    },

    async updateUser({ id, ...user }) {
      const updated = await prisma.user.update({
        where: { id },
        data: toUserData(user),
        select: USER_SELECT,
      });
      return toAdapterUser(updated);
    },

    async deleteUser(id) {
      try {
        await prisma.user.delete({ where: { id } });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    async linkAccount(account) {
      await prisma.account.create({ data: toAccountData(account) });
    },

    async unlinkAccount({ provider, providerAccountId }) {
      await prisma.account.delete({
        where: { provider_providerAccountId: { provider, providerAccountId } },
      });
    },

    async getAccount(providerAccountId, provider) {
      const account = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
      });
      return account ? toAdapterAccount(account) : null;
    },

    async createSession({ sessionToken, userId, expires }) {
      const session = await prisma.session.create({
        data: { sessionToken, userId, expiresAt: expires },
      });
      return toAdapterSession(session);
    },

    async getSessionAndUser(sessionToken) {
      const session = await prisma.session.findUnique({
        where: { sessionToken },
        include: { user: { select: USER_SELECT } },
      });
      if (!session) return null;
      const { user, ...rest } = session;
      return { session: toAdapterSession(rest as Session), user: toAdapterUser(user) };
    },

    async updateSession({ sessionToken, expires }) {
      try {
        const session = await prisma.session.update({
          where: { sessionToken },
          data: { ...(expires && { expiresAt: expires }) },
        });
        return toAdapterSession(session);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async deleteSession(sessionToken) {
      try {
        await prisma.session.delete({ where: { sessionToken } });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    async createVerificationToken({ identifier, token, expires }) {
      await prisma.verificationToken.create({
        data: { identifier, token, expiresAt: expires },
      });
      return { identifier, token, expires };
    },

    async useVerificationToken({ identifier, token }): Promise<VerificationToken | null> {
      try {
        const deleted = await prisma.verificationToken.delete({
          where: { identifier_token: { identifier, token } },
        });
        return { identifier: deleted.identifier, token: deleted.token, expires: deleted.expiresAt };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}
