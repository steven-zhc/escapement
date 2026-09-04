/**
 * Most of these need no database: a doctor whose environment check fails must
 * not go on to open connections, so the failure paths are pure.
 *
 * The last one does need it, and it is the one that matters — it is Phase 0's
 * exit criterion written as an assertion.
 */
import { databaseUrl, directDatabaseUrl } from "@lingtai/store";
import { describe, expect, it } from "vitest";
import { formatReport, runDoctor } from "../src/doctor.ts";

const POOLED = "postgresql://u:p@db.example.com:6543/postgres?pgbouncer=true";
const DIRECT = "postgresql://u:p@db.example.com:5432/postgres";

/** Only the two variables matter; the rest of the environment is noise here. */
const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;

function find(results: { name: string }[], name: string) {
  const r = results.find((x) => x.name === name);
  expect(r, `no check named ${name}`).toBeDefined();
  return r!;
}

describe("lingtai doctor — environment", () => {
  it("fails, and names which variable, when one is missing", async () => {
    const report = await runDoctor(env({ DATABASE_URL: POOLED }));
    const e = find(report.results, "environment");

    expect(e.status).toBe("fail");
    expect(e.detail).toContain("DIRECT_DATABASE_URL");
    expect(report.failed).toBeGreaterThan(0);
  });

  it("does not attempt Postgres once the environment is wrong", async () => {
    const report = await runDoctor(env({}));
    expect(find(report.results, "postgres").status).toBe("skip");
  });

  it("reports the two URLs separately, and never prints either", async () => {
    const report = await runDoctor(env({ DATABASE_URL: POOLED, DIRECT_DATABASE_URL: DIRECT }));
    const detail = find(report.results, "environment").detail;

    expect(detail).toContain(":6543");
    expect(detail).toContain(":5432");
    // Not the credentials, and not the host — on a hosted Postgres the project
    // identifier lives in the hostname.
    expect(detail).not.toContain("p@");
    expect(detail).not.toContain("db.example.com");
    expect(detail).not.toContain("postgresql://");
  });

  /**
   * The cheap half of the 0009 check. The expensive half — holding a listener
   * open and notifying from a second connection — cannot run without a database,
   * and is exercised in `lingtai doctor` itself against the real one.
   */
  it("fails when the direct URL still carries pgbouncer=true", async () => {
    const report = await runDoctor(
      env({ DATABASE_URL: POOLED, DIRECT_DATABASE_URL: `${DIRECT}?pgbouncer=true` }),
    );
    const e = find(report.results, "environment");

    expect(e.status).toBe("fail");
    expect(e.detail).toContain("pgbouncer=true");
  });

  it("fails when the two URLs are not the same database", async () => {
    const report = await runDoctor(
      env({
        DATABASE_URL: POOLED,
        DIRECT_DATABASE_URL: "postgresql://u:p@other.example.com:5432/postgres",
      }),
    );
    // A subscriber listening to one log while the writer appends to another is
    // not a configuration with a meaning.
    expect(find(report.results, "environment").status).toBe("fail");
    expect(find(report.results, "environment").detail).toContain("one database");
  });
});

describe("lingtai doctor — the runtime's own login", () => {
  /**
   * The check exists because the operator being signed in says nothing about
   * whether a *run* can sign in. A run's environment is filtered, and the first
   * real run against a repository died on "Not logged in" while the operator
   * was signed in perfectly well — the filtered environment had no `USER`, and
   * macOS finds a keychain item by who is asking.
   *
   * This asserts the check is present and reports on the *run's* environment.
   * Whether this machine happens to be signed in is not the test's business.
   */
  it("asks the runtime, and says which environment it asked in", async () => {
    const report = await runDoctor(env({}));
    const check = report.results.find((r) => r.name === "runtime: signed in");

    expect(check).toBeDefined();
    if (check?.status === "fail") {
      // A failure has to name the environment it probed, because "not signed
      // in" without that sends the reader to `/login` — which is the one thing
      // that would not have helped.
      expect(check.detail).toMatch(/filtered environment a run gets/);
      expect(check.detail).toContain("USER");
    } else {
      expect(check?.status).toBe("ok");
    }
  }, 60_000);
});

describe("lingtai doctor — reporting", () => {
  it("lists the checks that cannot run yet, rather than omitting them", async () => {
    // With no GITHUB_APP_ID in this environment, the credentials check is itself
    // a skip rather than a failure — not being onboarded is a legitimate state.
    const report = await runDoctor(env({}));
    const skipped = report.results.filter((r) => r.status === "skip").map((r) => r.name);

    expect(skipped).toContain("github: app credentials");

    // A check you cannot see is a check you will forget you never had.
    expect(skipped).toContain("hook: fail closed");
    expect(skipped).toContain("github: installation and labels");
  });

  /**
   * The reason is the whole value of a skip, and a deferred reason is a literal
   * — it cannot re-read the world. Two of them said no project was onboarded
   * while two were, and sent a reader off to re-run `lingtai add`.
   *
   * So a deferred detail may say why the check is not a startup check, and may
   * not describe the state of the installation it is running in. Asserted on
   * the `deferred` flag rather than on "skip", because a check skipped for a
   * reason (the environment failed first) is a different thing: that one is
   * *about* the state of this run, and has to be.
   */
  it("gives deferred checks a reason that cannot go stale", async () => {
    const report = await runDoctor(env({}));
    const deferred = report.results.filter((r) => r.deferred);
    expect(deferred.length).toBeGreaterThan(0);

    // The vocabulary of "what is installed right now". A fixed sentence that
    // reaches for one of these is claiming something it never looked at.
    const stateOfTheMachine = /onboard|registered|not yet|no project|is empty/i;
    for (const r of deferred) {
      expect(r.detail, `${r.name} claims a fact about this installation`).not.toMatch(stateOfTheMachine);
      // A reason, not a shrug.
      expect(r.detail.length, `${r.name} gives no reason`).toBeGreaterThan(40);
    }
  });

  it("says how many failed, and every check says what it found", async () => {
    const report = await runDoctor(env({}));
    expect(formatReport(report)).toContain("FAILED");
    expect(report.results.every((r) => r.detail.length > 0)).toBe(true);
  });
});

describe("lingtai doctor — against the real database", () => {
  /**
   * Phase 0's exit criterion, as an assertion: *`lingtai doctor` is green*.
   *
   * "Green" means nothing failed. The six deferred checks are skips, and they
   * stay visible in the output.
   */
  it("is green", async () => {
    const report = await runDoctor(
      env({ DATABASE_URL: databaseUrl(), DIRECT_DATABASE_URL: directDatabaseUrl() }),
    );

    const failures = report.results.filter((r) => r.status === "fail");
    expect(failures.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);

    // And the checks that carry the weight actually ran, rather than being
    // skipped into a green that means nothing.
    expect(find(report.results, "postgres: direct connection is session mode").status).toBe("ok");
    expect(find(report.results, "schema: optimistic concurrency").status).toBe("ok");
    expect(find(report.results, "schema: append-only").status).toBe("ok");
    expect(find(report.results, "schema: notify trigger").status).toBe("ok");
  }, 60_000);
});
