/**
 * The App's authentication, without an App.
 *
 * The JWT half is real: a keypair is generated here and the token this code
 * produces is verified with `node:crypto`, so "it signs an RS256 JWT GitHub will
 * accept" is checked rather than assumed. The HTTP half is stubbed, because the
 * behaviour under test is *when* a token is refetched, and that cannot be
 * observed against a live GitHub without waiting an hour.
 *
 * What is not covered here is whether a real installation answers — that is
 * `lingtai add`'s job against a real App, and it is the reason `lingtai add` checks
 * permissions before it writes anything.
 */
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AppAuth,
  type Installation,
  appJwt,
  createTokenSource,
  parseSlug,
  permissionGaps,
} from "../src/index.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const auth: AppAuth = { appId: "123456", privateKey };

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("appJwt", () => {
  it("signs something the public key actually verifies", () => {
    const token = appJwt(auth);
    const [header, payload, signature] = token.split(".");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(createPublicKey(publicKey), signature!, "base64url")).toBe(true);
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("claims the app, backdates iat, and stays inside GitHub's ten-minute ceiling", () => {
    const now = Date.parse("2026-08-31T12:00:00Z");
    const claims = decode(appJwt(auth, now).split(".")[1]!);

    expect(claims["iss"]).toBe("123456");
    // Backdated by a minute: GitHub rejects a token whose iat is in its future,
    // and a laptop's clock drifts.
    expect(claims["iat"]).toBe(now / 1000 - 60);
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBeLessThanOrEqual(600);
  });
});

describe("permissionGaps", () => {
  const installed = (permissions: Record<string, string>): Installation => ({
    id: 1,
    permissions,
    account: "steven-zhc",
    repositorySelection: "selected",
  });

  it("is empty when the installation grants everything", () => {
    expect(
      permissionGaps(
        installed({ issues: "write", contents: "write", pull_requests: "write", metadata: "read" }),
      ),
    ).toEqual([]);
  });

  /**
   * The failure 0006 exists for. A fine-grained PAT covered the admin
   * repository's submodule but not the repository, and every CI run failed with
   * a 403 that named nothing. A gap has to say which permission, what it has,
   * what it needs, and what it is for.
   */
  it("names each missing permission, what it has, and what it is for", () => {
    const gaps = permissionGaps(
      installed({ issues: "read", contents: "write", metadata: "read" }),
    );

    expect(gaps.map((g) => g.name).sort()).toEqual(["issues", "pull_requests"]);
    const issues = gaps.find((g) => g.name === "issues")!;
    expect(issues.have).toBe("read");
    expect(issues.need).toBe("write");
    expect(issues.why).toContain("labels");
    expect(gaps.find((g) => g.name === "pull_requests")!.have).toBe("none");
  });

  it("accepts a level above what is required", () => {
    expect(
      permissionGaps(
        installed({ issues: "write", contents: "write", pull_requests: "write", metadata: "write" }),
      ),
    ).toEqual([]);
  });
});

describe("createTokenSource", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** One stubbed token endpoint, counting how often it is actually called. */
  function stubTokens(expiresInMs: number) {
    let issued = 0;
    vi.stubGlobal("fetch", async () => {
      issued++;
      return new Response(
        JSON.stringify({
          token: `ghs_token_${issued}`,
          expires_at: new Date(Date.now() + expiresInMs).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    return () => issued;
  }

  it("fetches once and reuses the token", async () => {
    const issued = stubTokens(60 * 60_000);
    const tokenFor = createTokenSource(auth, 42);

    expect(await tokenFor()).toBe("ghs_token_1");
    expect(await tokenFor()).toBe("ghs_token_1");
    expect(await tokenFor()).toBe("ghs_token_1");
    expect(issued()).toBe(1);
  });

  it("refreshes before expiry rather than after a 401", async () => {
    // Inside the one-minute margin: valid, but not valid enough to start a merge
    // with. The refresh has to happen here rather than when a call fails.
    const issued = stubTokens(30_000);
    const tokenFor = createTokenSource(auth, 42);

    expect(await tokenFor()).toBe("ghs_token_1");
    expect(await tokenFor()).toBe("ghs_token_2");
    expect(issued()).toBe(2);
  });

  it("coalesces a burst into one token request", async () => {
    const issued = stubTokens(60 * 60_000);
    const tokenFor = createTokenSource(auth, 42);

    const tokens = await Promise.all([tokenFor(), tokenFor(), tokenFor(), tokenFor()]);

    expect(new Set(tokens).size).toBe(1);
    // A burst of calls after expiry must not become a burst of token requests.
    expect(issued()).toBe(1);
  });

  it("surfaces a rejection from the token endpoint rather than caching it", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    });
    const tokenFor = createTokenSource(auth, 42);

    await expect(tokenFor()).rejects.toThrow(/401.*Bad credentials/);
    await expect(tokenFor()).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe("parseSlug", () => {
  it("splits owner from repo", () => {
    expect(parseSlug("steven-zhc/nextloom-ai-admin")).toEqual({
      owner: "steven-zhc",
      repo: "nextloom-ai-admin",
    });
  });

  it("says what was wrong rather than guessing", () => {
    expect(() => parseSlug("nextloom-ai-admin")).toThrow(/is not owner\/repo/);
    expect(() => parseSlug("a/b/c")).toThrow();
  });
});
