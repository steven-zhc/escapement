/**
 * The guard's matrix: both lists, because a deny list without an allow list is
 * a deny list nobody can trust.
 *
 * 132 blocks fired across 56 of 73 runs of the old loop and not one pattern was
 * ever tuned, because nobody could see which were firing. These cases are that
 * conversation, written down: every entry says what it protects, and a false
 * positive here is an argument to have rather than a mystery.
 *
 * None of this is a security boundary — a model can write a script and run it to
 * step around a pattern. See the module header and doc/decisions/0007.
 */
import { describe, expect, it } from "vitest";
import { type GuardPolicy, evaluate, redact } from "../src/index.ts";

const policy: GuardPolicy = {
  base: "develop",
  productionPatterns: ["prod", "production"],
};

const bash = (command: string) => ({ tool: "Bash", input: { command } });
const read = (file_path: string) => ({ tool: "Read", input: { file_path } });
const write = (file_path: string) => ({ tool: "Write", input: { file_path } });

function verdict(call: Parameters<typeof evaluate>[0]) {
  return evaluate(call, policy);
}

describe("blocks", () => {
  const blocked: [string, ReturnType<typeof bash>, string][] = [
    [
      "a production host in a connection string",
      bash("psql postgresql://u:p@db.prod.example.com/app -c 'select 1'"),
      "production-host",
    ],
    ["executed DDL", bash("psql $DATABASE_URL -c 'drop table users'"), "executed-ddl"],
    ["an ALTER through prisma db execute", bash("prisma db execute --stdin <<< 'alter table t add c int'"), "executed-ddl"],
    ["prisma db push", bash("pnpm prisma db push"), "db-push"],
    ["gh pr merge", bash("gh pr merge 117 --squash"), "pr-merge"],
    ["pushing to the base branch", bash("git push origin develop"), "push-to-base"],
    ["pushing HEAD to the base branch", bash("git push origin HEAD:develop"), "push-to-base"],
    ["a force push", bash("git push --force origin agent/117"), "force-push"],
    ["a short force push", bash("git push -f origin agent/117"), "force-push"],
    ["a refspec force push", bash("git push origin +agent/117:agent/117"), "force-push"],
    ["rm -rf", bash("rm -rf node_modules"), "recursive-delete"],
    ["rm -fr", bash("rm -fr /tmp/x"), "recursive-delete"],
  ];

  for (const [what, call, rule] of blocked) {
    it(`refuses ${what}`, () => {
      const v = verdict(call);
      expect(v.allow, `${what} was allowed`).toBe(false);
      if (v.allow) return;
      expect(v.rule).toBe(rule);
      // A trip on the board has to explain itself, or nobody can tune it.
      expect(v.why.length).toBeGreaterThan(20);
    });
  }

  it("refuses reading .env, and says why .env.local is different", () => {
    expect(verdict(read("apps/web/.env")).allow).toBe(false);
    expect(verdict(read(".env.production")).allow).toBe(false);
    expect(verdict(bash("cat .env")).allow).toBe(false);
  });

  it("takes extra denials from the project without losing the built-in ones", () => {
    const extra: GuardPolicy = {
      ...policy,
      deny: [{ name: "no-curl", pattern: "\\bcurl\\b", why: "this project forbids network fetches" }],
    };
    expect(evaluate(bash("curl https://example.com"), extra)).toMatchObject({
      allow: false,
      rule: "no-curl",
    });
    expect(evaluate(bash("rm -rf x"), extra)).toMatchObject({ allow: false, rule: "recursive-delete" });
  });
});

describe("allows", () => {
  const allowed: [string, ReturnType<typeof bash>][] = [
    ["a dev-database read", bash("psql $DATABASE_URL -c 'select count(*) from users'")],
    ["a dev-database write", bash("psql $DATABASE_URL -c \"insert into users (id) values ('x')\"")],
    ["running the tests", bash("pnpm verify")],
    ["running one test file", bash("pnpm vitest run src/a.test.ts")],
    ["pushing an agent branch", bash("git push origin agent/117")],
    ["pushing with upstream set", bash("git push -u origin agent/117")],
    ["opening a pull request", bash("gh pr create --fill")],
    ["reading a PR", bash("gh pr view 117")],
    ["an ordinary delete", bash("rm dist/old.js")],
    ["installing dependencies", bash("pnpm install")],
    ["a migration through prisma migrate", bash("pnpm prisma migrate dev --name add-index")],
  ];

  for (const [what, call] of allowed) {
    it(`allows ${what}`, () => {
      const v = verdict(call);
      expect(v.allow, `${what} was refused as ${v.allow ? "" : v.rule}`).toBe(true);
    });
  }

  it("allows reading the .env.local the conductor planted", () => {
    // It is the file Escapement wrote for this run; reading it is the point.
    expect(verdict(read("apps/web/.env.local")).allow).toBe(true);
  });

  /**
   * The case the `executed-ddl` rule would otherwise break. A migration file is
   * how a schema is *supposed* to change, and it contains exactly the DDL the
   * rule looks for.
   */
  it("allows writing a migration that contains DDL", () => {
    expect(verdict(write("prisma/migrations/20260901_add_index/migration.sql")).allow).toBe(true);
    expect(verdict(write("packages/db/migrations/0002_alter/migration.ts")).allow).toBe(true);
  });

  /** `reproducible` contains `prod`. Segment matching is what makes this pass. */
  it("does not mistake a dev host containing 'reproducible' for production", () => {
    expect(verdict(bash("psql postgresql://u:p@reproducible.dev.example.com/app -c 'select 1'")).allow).toBe(
      true,
    );
  });
});

describe("redact", () => {
  it("removes the credential from a connection string", () => {
    expect(redact("psql postgresql://user:hunter2@db.example.com/app")).toBe(
      "psql postgresql://***@db.example.com/app",
    );
  });

  it("removes tokens and --password style flags", () => {
    // The `--token ` flag rule fires first and takes the whole value, which is
    // more redacted than the prefix rule would have left it.
    expect(redact("gh auth login --token ghp_abcdefghijklmnop")).toBe("gh auth login --token ***");
    expect(redact("echo ghp_abcdefghijklmnop")).toContain("ghp_***");
    expect(redact("mysql --password=hunter2")).toContain("--password=***");
    expect(redact("CLERK_SECRET_KEY=sk_live_abcdefgh pnpm dev")).toContain("CLERK_SECRET_KEY=***");
  });

  it("keeps enough of the command to be recognisable", () => {
    // The event has to be worth reading: the shape of what happened, never the
    // value that made it dangerous.
    expect(redact("psql postgresql://u:p@db.example.com/app -c 'drop table users'")).toContain(
      "drop table users",
    );
  });

  it("caps its length, because a command can be a whole file", () => {
    expect(redact("x".repeat(5_000))).toHaveLength(500);
  });
});
