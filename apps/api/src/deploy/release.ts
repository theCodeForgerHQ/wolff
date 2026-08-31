/**
 * One-command release of the three Vercel projects (Phase 6):
 * deploy each to production, smoke-test the production URL, and when a smoke
 * test fails, roll every project this run deployed back to the production
 * deployment it had before (`vercel rollback`). Side effects come in through
 * `ReleaseDeps`, so the decisions are unit-tested and the script only wires
 * the Vercel CLI, the Vercel REST API and fetch.
 */

export interface SmokeCheck {
  /** Path on the production URL. */
  path: string;
  method?: 'GET' | 'HEAD';
  status: number;
  /** Substring the body must contain. */
  contains?: string;
  headers?: Record<string, string>;
}

export interface ReleaseTarget {
  name: string;
  projectId: string;
  /** Directory of the source archive to deploy from. */
  dir: string;
  productionUrl: string;
  smoke: SmokeCheck[];
}

export interface ReleaseDeps {
  /** URL of the current production deployment, or undefined for a first deploy. */
  currentProduction(target: ReleaseTarget): Promise<string | undefined>;
  /** Deploys to production and returns the new deployment URL. */
  deploy(target: ReleaseTarget): Promise<string>;
  rollback(target: ReleaseTarget, toDeploymentUrl: string): Promise<void>;
  /** Points the production domain at a deployment (`vercel promote`). */
  promote(target: ReleaseTarget, deploymentUrl: string): Promise<void>;
  request(
    url: string,
    init: { method: string; headers: Record<string, string> }
  ): Promise<{ status: number; body: string }>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  now(): number;
}

export interface ReleaseResult {
  ok: boolean;
  deployed: { name: string; url: string; previous?: string }[];
  failed?: { name: string; reason: string };
  rolledBack: string[];
  /** Rollbacks that threw; the other projects are still rolled back. */
  rollbackFailed: { name: string; reason: string }[];
  /** After a rollback: every rolled-back project passes its checks again. */
  recovered?: boolean;
  /** Milliseconds per phase, for the runbook's timings. */
  timings: Record<string, number>;
}

export const SMOKE_ATTEMPTS = 4;
export const SMOKE_DELAY_MS = 5_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A release step that threw, labelled with the step for the report. */
class StepError extends Error {}

/** Returns why a check failed, or undefined when it passed. */
async function runCheck(
  target: ReleaseTarget,
  check: SmokeCheck,
  deps: ReleaseDeps
): Promise<string | undefined> {
  const url = target.productionUrl.replace(/\/$/, '') + check.path;
  const method = check.method ?? 'GET';
  let reason = '';
  // A few tries: a fresh deployment's first request can be a cold start.
  for (let attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++) {
    try {
      const response = await deps.request(url, { method, headers: check.headers ?? {} });
      if (response.status !== check.status) {
        reason = `${method} ${check.path} answered ${response.status}, expected ${check.status}`;
      } else if (check.contains && !response.body.includes(check.contains)) {
        reason = `${method} ${check.path} body lacks ${JSON.stringify(check.contains)}`;
      } else {
        return undefined;
      }
    } catch (error) {
      reason = `${method} ${check.path} failed: ${message(error)}`;
    }
    if (attempt < SMOKE_ATTEMPTS) await deps.sleep(SMOKE_DELAY_MS);
  }
  return reason;
}

export async function release(targets: ReleaseTarget[], deps: ReleaseDeps): Promise<ReleaseResult> {
  const result: ReleaseResult = {
    ok: true,
    deployed: [],
    rolledBack: [],
    rollbackFailed: [],
    timings: {},
  };
  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const start = deps.now();
    try {
      return await work();
    } finally {
      result.timings[label] = deps.now() - start;
    }
  };
  /** Runs one Vercel call; any error becomes a StepError naming the step. */
  const step = async <T>(kind: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new StepError(`${kind} failed: ${message(error)}`);
    }
  };

  for (const target of targets) {
    try {
      await releaseOne(target);
    } catch (error) {
      if (!(error instanceof StepError)) throw error;
      result.failed = { name: target.name, reason: error.message };
      break;
    }
    if (result.failed) break;
  }

  async function releaseOne(target: ReleaseTarget): Promise<void> {
    const previous = await step('alias lookup', () => deps.currentProduction(target));
    // Nothing was promoted for this target if deploy throws; the ones before
    // it are still undone below.
    const url = await timed(`${target.name}.deploy`, () =>
      step('deploy', () => deps.deploy(target))
    );
    // Recorded before promote: Vercel may already have pointed the domain at
    // the new deployment, so a later failure must roll this project back too.
    result.deployed.push({ name: target.name, url, previous });
    // After a rollback Vercel stops assigning the production domain to new
    // deployments until one is promoted; without this the smoke test would
    // pass against the old deployment.
    if ((await step('alias lookup', () => deps.currentProduction(target))) !== url) {
      await timed(`${target.name}.promote`, () => step('promote', () => deps.promote(target, url)));
    }
    deps.log(`${target.name}: deployed ${url}`);

    let reason: string | undefined;
    await timed(`${target.name}.smoke`, async () => {
      for (const check of target.smoke) {
        reason = await runCheck(target, check, deps);
        if (reason) break;
      }
    });
    if (reason) {
      result.failed = { name: target.name, reason };
      return;
    }
    deps.log(`${target.name}: smoke tests passed`);
  }

  if (!result.failed) return result;

  result.ok = false;
  deps.log(`${result.failed.name}: ${result.failed.reason}; rolling back`);
  for (const done of [...result.deployed].reverse()) {
    const target = targets.find((t) => t.name === done.name)!;
    if (!done.previous) {
      deps.log(`${done.name}: no earlier production deployment to roll back to`);
      continue;
    }
    // Each rollback on its own: one refusal must not leave the rest new.
    try {
      await timed(`${done.name}.rollback`, () => deps.rollback(target, done.previous!));
    } catch (error) {
      result.rollbackFailed.push({ name: done.name, reason: message(error) });
      deps.log(`${done.name}: ROLLBACK FAILED: ${message(error)}`);
      continue;
    }
    result.rolledBack.push(done.name);
    deps.log(`${done.name}: rolled back to ${done.previous}`);
  }
  // Prove the rollback: the projects rolled back must pass their checks again.
  result.recovered = result.rollbackFailed.length === 0;
  for (const name of result.rolledBack) {
    const target = targets.find((t) => t.name === name)!;
    for (const check of target.smoke) {
      const again = await runCheck(target, check, deps);
      if (again) {
        deps.log(`${name}: STILL FAILING after rollback: ${again}`);
        result.recovered = false;
        break;
      }
    }
  }
  return result;
}
