// V5.5 tour 3 round 5 (finding 26 of the design audit, 27.09): login from a repo card
// returns to that card. Behavioral: the path filter (no open redirect), the client
// login href, and the real /auth/ya -> callback round trip on a spawned server
// (mock Ya ID), including the default "/me" when no path was given.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeNextPath } from "../src/auth/session";
import { loginHref } from "../src/web/router";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

describe("safeNextPath: only a path of our own site", () => {
  test("own paths pass, with query", () => {
    expect(safeNextPath("/repo/org/name")).toBe("/repo/org/name");
    expect(safeNextPath("/repo/org/name?x=1")).toBe("/repo/org/name?x=1");
    expect(safeNextPath("/")).toBe("/");
  });

  test("foreign hosts, schemes and tricks are refused", () => {
    for (const bad of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "repo/org/name",
      "/repo/\u0000x",
      "/auth/ya",
      "/auth/ya/callback?code=1",
      "/api/me",
      "",
      `/${"a".repeat(600)}`,
    ]) {
      expect({ bad, out: safeNextPath(bad) }).toEqual({ bad, out: null });
    }
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});

describe("loginHref: return only from a repo card", () => {
  test("card -> next with the card path; other screens -> plain login", () => {
    expect(loginHref("/repo/org/name", "")).toBe(`/auth/ya?next=${encodeURIComponent("/repo/org/name")}`);
    expect(loginHref("/repo/o/r", "?tab=1")).toBe(`/auth/ya?next=${encodeURIComponent("/repo/o/r?tab=1")}`);
    expect(loginHref("/", "")).toBe("/auth/ya");
    expect(loginHref("/me", "")).toBe("/auth/ya");
  });
});

const SECRET = "login-return-test-secret-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "rh-login-return-"));
const mock = startMockApi((_req, url) => {
  if (url.pathname === "/token") return Response.json({ access_token: "ya-access-token-value" });
  if (url.pathname === "/info") return Response.json({ id: 515151, login: "returner", real_name: "Р", default_avatar_id: "av-1" });
  return null;
});
let server: SpawnedServer | null = null;

beforeAll(async () => {
  server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET, env: { YA_CLIENT_ID: "cid", YA_CLIENT_SECRET: "csecret" } });
}, 30_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows EBUSY */
  }
});

const at = (path: string) => `${server!.base}${path}`;

async function roundTrip(start: string): Promise<{ location: string; cleared: boolean }> {
  const res = await fetch(at(start), { redirect: "manual" });
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
  const cb = await fetch(at(`/auth/ya/callback?code=good&state=${encodeURIComponent(state)}`), { redirect: "manual", headers: { cookie: cookies } });
  expect(cb.status).toBe(302);
  const cleared = cb.headers.getSetCookie().some((c) => c.startsWith("rh_oauth_state_next=;") && c.includes("Max-Age=0"));
  return { location: new URL(cb.headers.get("location")!, server!.base).pathname + new URL(cb.headers.get("location")!, server!.base).search, cleared };
}

describe("/auth/ya -> callback: return path", () => {
  test("login from a card returns to the card; the return cookie is cleared", async () => {
    const out = await roundTrip(`/auth/ya?next=${encodeURIComponent("/repo/org/name")}`);
    expect(out).toEqual({ location: "/repo/org/name", cleared: true });
  });

  test("no next -> cabinet, as before (default preserved)", async () => {
    expect((await roundTrip("/auth/ya")).location).toBe("/me");
  });

  test("foreign next is ignored -> cabinet, never an external redirect", async () => {
    expect((await roundTrip(`/auth/ya?next=${encodeURIComponent("//evil.example/x")}`)).location).toBe("/me");
  });
});
