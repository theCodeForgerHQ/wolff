/**
 * One Postgres database per package for the test suites.
 *
 * `pnpm test` runs the packages in parallel (turbo), and within a package
 * the files run one after another. With one TEST_DATABASE_URL for all of
 * them, one package's TRUNCATE or cleanup ran against another's rows and
 * locks, and suites failed at random. Each package now gets a copy of the
 * migrated base database, named after the package.
 */

const IDENT = /^[a-z_][a-z0-9_]*$/;

export interface PackageDatabase {
  /** Database of this package: `<base>_t_<package>`. */
  name: string;
  url: string;
  /** The migrated base database (TEST_DATABASE_URL) it is copied from. */
  template: string;
  /** Same server, the `postgres` maintenance database, for CREATE/DROP. */
  adminUrl: string;
}

export function packageDatabaseUrl(baseUrl: string, packageName: string): PackageDatabase {
  const url = new URL(baseUrl);
  const template = decodeURIComponent(url.pathname.slice(1));
  const short = packageName.replace(/^@[^/]+\//, '');
  const name = `${template}_t_${short}`;
  for (const value of [template, name]) {
    if (!IDENT.test(value) || value.length > 63) {
      throw new Error(`Refusing test database name ${JSON.stringify(value)}`);
    }
  }
  const at = (database: string) => {
    const copy = new URL(url);
    copy.pathname = `/${database}`;
    return copy.toString();
  };
  return { name, url: at(name), template, adminUrl: at('postgres') };
}
