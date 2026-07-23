import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import { createHandler, type ServiceContext } from "./app.js";
import type { Account, AccountsStore, CurrentSelection, LoginCurrentSelection } from "./repo.js";
import { AccountsError } from "../types.js";
import { AccountIncarnationConflictError } from "./errors.js";
import { buildOpenApiDoc } from "./openapi.js";

const SIGNING_SECRET = "test-signing-secret-accounts";

/** In-memory AccountsStore mirroring the PG repo's domain semantics. */
class MemoryStore implements AccountsStore {
  private accounts = new Map<string, Account>();
  private current = new Map<string, CurrentSelection>();
  private revision = 0;
  private currentLoginOperations = new Map<string, string>();
  private completedLoginOperations = new Map<string, {
    selection: LoginCurrentSelection;
    targetIncarnationId: string;
  }>();
  private cleanupOperations = new Map<string, { tool: string; name: string; incarnationId: string; removed: boolean }>();
  private key(tool: string, name: string) {
    return `${tool}\u0000${name}`;
  }
  async list(tool?: string): Promise<Account[]> {
    return [...this.accounts.values()]
      .filter((a) => !tool || a.tool === tool)
      .sort((a, b) => a.tool.localeCompare(b.tool) || a.name.localeCompare(b.name));
  }
  async get(tool: string, name: string): Promise<Account | null> {
    return this.accounts.get(this.key(tool, name)) ?? null;
  }
  async create(input: any): Promise<Account> {
    if (this.accounts.has(this.key(input.tool, input.name))) {
      throw new AccountsError(`a ${input.tool} profile named "${input.name}" already exists`);
    }
    const account: Account = {
      tool: input.tool,
      name: input.name,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
      incarnationId: randomUUID(),
      ...(input.email ? { email: input.email } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.dir ? { dir: input.dir } : {}),
      ...(input.description ? { description: input.description } : {}),
    };
    this.accounts.set(this.key(input.tool, input.name), account);
    return account;
  }
  async createForLogin(input: any): Promise<Account> {
    const existing = this.accounts.get(this.key(input.tool, input.name));
    if (existing) {
      if (existing.incarnationId === input.expectedIncarnationId) return existing;
      throw new AccountsError(`a ${input.tool} profile named "${input.name}" already exists`);
    }
    const account = await this.create(input);
    const owned = { ...account, incarnationId: input.expectedIncarnationId };
    this.accounts.set(this.key(input.tool, input.name), owned);
    return owned;
  }
  async update(tool: string, name: string, input: any): Promise<Account> {
    const existing = this.accounts.get(this.key(tool, name));
    if (!existing) throw new AccountsError(`no profile named "${name}" for tool "${tool}"`);
    const updated = { ...existing };
    if (input.email !== undefined) updated.email = input.email ?? undefined;
    if (input.description !== undefined) updated.description = input.description ?? undefined;
    if (input.metadata !== undefined) updated.metadata = { ...existing.metadata, ...input.metadata };
    if (input.lastUsedAt !== undefined) updated.lastUsedAt = input.lastUsedAt ?? undefined;
    this.accounts.set(this.key(tool, name), updated);
    return updated;
  }
  async updateForLogin(tool: string, name: string, input: any): Promise<Account> {
    const existing = this.accounts.get(this.key(tool, name));
    if (!existing) throw new AccountsError(`no profile named "${name}" for tool "${tool}"`);
    if (existing.incarnationId !== input.expectedIncarnationId) {
      throw new AccountIncarnationConflictError();
    }
    const updated = { ...existing, email: input.email };
    this.accounts.set(this.key(tool, name), updated);
    return updated;
  }
  async restoreProfile(tool: string, name: string, input: any): Promise<Account> {
    const existing = this.accounts.get(this.key(tool, name));
    if (!existing) throw new AccountsError(`no profile named "${name}" for tool "${tool}"`);
    if (existing.incarnationId !== input.expectedIncarnationId) return existing;
    const restored = { ...existing };
    if (input.email && (restored.email ?? null) === input.email.expected) {
      restored.email = input.email.restore ?? undefined;
    }
    if (input.lastUsedAt && (restored.lastUsedAt ?? null) === input.lastUsedAt.expected) {
      restored.lastUsedAt = input.lastUsedAt.restore ?? undefined;
    }
    this.accounts.set(this.key(tool, name), restored);
    return restored;
  }
  async removeCreated(tool: string, name: string, input: any) {
    const completed = this.cleanupOperations.get(input.cleanupOperationId);
    if (completed) {
      if (completed.tool !== tool || completed.name !== name || completed.incarnationId !== input.expectedIncarnationId) {
        throw new AccountsError("login cleanup operation id is already bound to another profile");
      }
      return {
        removed: completed.removed,
        currentExists: this.accounts.has(this.key(tool, name)),
        expired: false,
      };
    }
    const finish = (removed: boolean) => {
      this.cleanupOperations.set(input.cleanupOperationId, {
        tool,
        name,
        incarnationId: input.expectedIncarnationId,
        removed,
      });
      return {
        removed,
        currentExists: this.accounts.has(this.key(tool, name)),
        expired: false,
      };
    };
    const existing = this.accounts.get(this.key(tool, name));
    if (!existing || this.current.get(tool)?.name === name) return finish(false);
    if (
      existing.incarnationId !== input.expectedIncarnationId ||
      existing.createdAt !== input.expectedCreatedAt ||
      (existing.email ?? null) !== input.expectedEmail ||
      (existing.displayName ?? null) !== input.expectedDisplayName ||
      (existing.identity ?? null) !== input.expectedIdentity ||
      (existing.cardLast4 ?? null) !== input.expectedCardLast4 ||
      JSON.stringify(existing.metadata) !== JSON.stringify(input.expectedMetadata) ||
      (existing.dir ?? null) !== input.expectedDir ||
      (existing.description ?? null) !== input.expectedDescription ||
      (existing.lastUsedAt ?? null) !== input.expectedLastUsedAt
    ) {
      return finish(false);
    }
    return finish(this.accounts.delete(this.key(tool, name)));
  }
  async rename(tool: string, oldName: string, newName: string): Promise<Account> {
    const existing = this.accounts.get(this.key(tool, oldName));
    if (!existing) throw new AccountsError(`no profile named "${oldName}" for tool "${tool}"`);
    if (oldName !== newName && this.accounts.has(this.key(tool, newName))) {
      throw new AccountsError(`a ${tool} profile named "${newName}" already exists`);
    }
    this.accounts.delete(this.key(tool, oldName));
    const renamed = { ...existing, name: newName };
    this.accounts.set(this.key(tool, newName), renamed);
    const cur = this.current.get(tool);
    if (cur && cur.name === oldName) this.current.set(tool, { ...cur, name: newName });
    return renamed;
  }
  async remove(tool: string, name: string): Promise<boolean> {
    const ok = this.accounts.delete(this.key(tool, name));
    const cur = this.current.get(tool);
    if (cur && cur.name === name) this.current.delete(tool);
    return ok;
  }
  async listCurrent(): Promise<CurrentSelection[]> {
    return [...this.current.values()];
  }
  async getCurrent(tool: string): Promise<CurrentSelection | null> {
    return this.current.get(tool) ?? null;
  }
  async setCurrent(tool: string, name: string): Promise<CurrentSelection> {
    const account = this.accounts.get(this.key(tool, name));
    if (!account) {
      throw new AccountsError(`no profile named "${name}" for tool "${tool}"`);
    }
    const updatedAt = new Date().toISOString();
    this.accounts.set(this.key(tool, name), { ...account, lastUsedAt: updatedAt });
    const sel = { tool, name, updatedAt, revision: String(++this.revision) };
    this.current.set(tool, sel);
    this.currentLoginOperations.delete(tool);
    return sel;
  }
  async setCurrentForLogin(tool: string, name: string, operationId: string, expectedIncarnationId: string) {
    const completed = this.completedLoginOperations.get(operationId);
    if (completed) {
      if (completed.selection.tool !== tool || completed.selection.name !== name) {
        throw new AccountsError("login operation id is already bound to another profile");
      }
      const account = this.accounts.get(this.key(tool, name));
      if (expectedIncarnationId !== completed.targetIncarnationId) {
        throw new AccountsError("login operation id is already bound to another profile incarnation");
      }
      if (!account || account.incarnationId !== completed.targetIncarnationId) {
        throw new AccountsError("profile changed while login activation was in progress");
      }
      return completed.selection;
    }
    const account = this.accounts.get(this.key(tool, name));
    if (!account) throw new AccountsError(`no profile named "${name}" for tool "${tool}"`);
    if (account.incarnationId !== expectedIncarnationId) {
      throw new AccountsError("profile changed while login activation was in progress");
    }
    const displaced = this.current.get(tool);
    const current = await this.setCurrent(tool, name);
    const result = {
      ...current,
      operationId,
      ...(displaced ? { previousName: displaced.name } : {}),
      ...(account.lastUsedAt ? { previousTargetLastUsedAt: account.lastUsedAt } : {}),
    };
    this.currentLoginOperations.set(tool, operationId);
    this.completedLoginOperations.set(operationId, {
      selection: result,
      targetIncarnationId: account.incarnationId,
    });
    return result;
  }
  async restoreCurrent(
    tool: string,
    expectedName: string,
    expectedRevision?: string,
    name?: string,
    restoreLastUsedAt?: string | null,
  ): Promise<boolean> {
    const existing = this.current.get(tool);
    if (existing?.name !== expectedName || (expectedRevision && existing.revision !== expectedRevision)) return false;
    if (name) {
      if (!this.accounts.has(this.key(tool, name))) {
        throw new AccountsError(`no profile named "${name}" for tool "${tool}"`);
      }
      this.current.set(tool, {
        tool,
        name,
        updatedAt: new Date().toISOString(),
        revision: String(++this.revision),
      });
    } else {
      this.current.delete(tool);
    }
    const failed = this.accounts.get(this.key(tool, expectedName));
    if (restoreLastUsedAt !== undefined && failed?.lastUsedAt === existing.updatedAt) {
      this.accounts.set(this.key(tool, expectedName), {
        ...failed,
        lastUsedAt: restoreLastUsedAt ?? undefined,
      });
    }
    return true;
  }
  async restoreCurrentOperation(
    tool: string,
    expectedName: string,
    operationId: string,
    _name?: string,
    _restoreLastUsedAt?: string | null,
  ): Promise<boolean> {
    if (this.currentLoginOperations.get(tool) !== operationId) return false;
    const owned = this.current.get(tool);
    const operation = this.completedLoginOperations.get(operationId)?.selection;
    if (!operation) return false;
    const restored = await this.restoreCurrent(tool, expectedName, undefined, operation.previousName);
    if (restored) {
      this.currentLoginOperations.delete(tool);
      const failed = this.accounts.get(this.key(tool, expectedName));
      if (failed?.lastUsedAt === owned?.updatedAt) {
        this.accounts.set(this.key(tool, expectedName), {
          ...failed,
          lastUsedAt: operation.previousTargetLastUsedAt,
        });
      }
    }
    return restored;
  }
  private customTools = new Map<string, any>();
  async listCustomTools(): Promise<any[]> {
    return [...this.customTools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  async addCustomTool(def: any): Promise<any> {
    this.customTools.set(def.id, def);
    return def;
  }
  async removeCustomTool(id: string): Promise<boolean> {
    const inUse = [...this.accounts.values()].some((a) => a.tool === id);
    if (inUse) throw new AccountsError(`cannot remove "${id}": still used by profile(s)`);
    return this.customTools.delete(id);
  }
}

function makeCtx(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return {
    repo: new MemoryStore(),
    verifier: verifyApiKey({ app: "accounts", signingSecret: SIGNING_SECRET }),
    health: async () => ({ ok: true }),
    ready: async () => ({ ready: true }),
    mode: "cloud",
    version: "9.9.9",
    close: async () => {},
    ...overrides,
  };
}

function key(scopes: string[]): string {
  return mintApiKey({ app: "accounts", scopes, signingSecret: SIGNING_SECRET }).token;
}

function req(method: string, path: string, opts: { key?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.key) headers["x-api-key"] = opts.key;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return new Request(`http://localhost${path}`, init);
}

describe("accounts-serve handler", () => {
  test("GET /health is public and matches the contract shape", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(req("GET", "/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", version: "9.9.9", mode: "cloud" });
  });

  test("GET /health reports unavailable when the DB is down", async () => {
    const handle = createHandler(makeCtx({ health: async () => ({ ok: false, error: "down" }) }));
    const res = await handle(req("GET", "/health"));
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("unavailable");
  });

  test("GET /ready 503 when migrations pending", async () => {
    const handle = createHandler(makeCtx({ ready: async () => ({ ready: false, reason: "pending migrations: x" }) }));
    const res = await handle(req("GET", "/ready"));
    expect(res.status).toBe(503);
    expect((await res.json()).ready).toBe(false);
  });

  test("GET /version returns the version", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(req("GET", "/version"));
    expect(await res.json()).toEqual({ version: "9.9.9" });
  });

  test("v1 requires an API key (401)", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(req("GET", "/v1/accounts"));
    expect(res.status).toBe(401);
  });

  test("read scope cannot write (403)", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(
      req("POST", "/v1/accounts", { key: key(["accounts:read"]), body: { name: "alice", tool: "claude" } }),
    );
    expect(res.status).toBe(403);
  });

  test("full CRUD roundtrip with a write key", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);

    // create
    let res = await handle(
      req("POST", "/v1/accounts", { key: admin, body: { name: "alice", tool: "claude", email: "alice@example.com" } }),
    );
    expect(res.status).toBe(201);
    const created = await res.json() as Account;
    expect(created.name).toBe("alice");

    // duplicate -> 409
    res = await handle(req("POST", "/v1/accounts", { key: admin, body: { name: "alice", tool: "claude" } }));
    expect(res.status).toBe(409);

    // list
    res = await handle(req("GET", "/v1/accounts", { key: admin }));
    expect((await res.json()).accounts).toHaveLength(1);

    // get
    res = await handle(req("GET", "/v1/accounts/claude/alice", { key: admin }));
    expect((await res.json()).email).toBe("alice@example.com");

    // update
    res = await handle(req("PATCH", "/v1/accounts/claude/alice", { key: admin, body: { description: "primary" } }));
    expect((await res.json()).description).toBe("primary");

    // field-scoped rollback restores only the finalizer-owned value
    res = await handle(req("PATCH", "/v1/accounts/claude/alice", {
      key: admin,
      body: { email: "finalized@example.com", description: "concurrent edit" },
    }));
    expect((await res.json()).email).toBe("finalized@example.com");
    res = await handle(req("PATCH", "/v1/accounts/claude/alice/login/update", {
      key: admin,
      body: {
        expectedIncarnationId: created.incarnationId,
        expectedEmail: "finalized@example.com",
        email: "login-finalized@example.com",
      },
    }));
    expect((await res.json()).email).toBe("login-finalized@example.com");
    // Earlier candidates exposed this non-discriminated route and stripped
    // unknown ownership fields; new clients must get 404 from old replicas.
    res = await handle(req("POST", "/v1/accounts/claude/alice/restore", {
      key: admin,
      body: {
        expectedIncarnationId: created.incarnationId,
        email: { expected: "login-finalized@example.com", restore: "alice@example.com" },
      },
    }));
    expect(res.status).toBe(404);
    res = await handle(req("POST", "/v1/accounts/claude/alice/login/restore", {
      key: admin,
      body: {
        expectedIncarnationId: created.incarnationId,
        email: { expected: "login-finalized@example.com", restore: "alice@example.com" },
      },
    }));
    expect(await res.json()).toMatchObject({ email: "alice@example.com", description: "concurrent edit" });

    // set current
    res = await handle(req("PUT", "/v1/current/claude", { key: admin, body: { name: "alice" } }));
    expect(res.status).toBe(200);
    const selection = await res.json() as CurrentSelection;
    res = await handle(req("PUT", "/v1/current/claude", { key: admin, body: { name: "alice" } }));
    const newerSelection = await res.json() as CurrentSelection;
    expect(newerSelection.revision).not.toBe(selection.revision);
    res = await handle(req("GET", "/v1/current/claude", { key: admin }));
    expect((await res.json()).name).toBe("alice");
    res = await handle(req("GET", "/v1/current", { key: admin }));
    expect(await res.json()).toMatchObject({
      transactionalLoginRollback: true,
      current: [{ tool: "claude", name: "alice" }],
    });

    // rollback clears only the expected failed selection
    res = await handle(req("POST", "/v1/current/claude/login/restore", {
      key: admin,
      body: { expectedName: "alice", expectedRevision: selection.revision },
    }));
    expect(await res.json()).toEqual({ restored: false });
    res = await handle(req("POST", "/v1/current/claude/login/restore", {
      key: admin,
      body: { expectedName: "alice", expectedRevision: newerSelection.revision },
    }));
    expect(await res.json()).toEqual({ restored: true });
    res = await handle(req("GET", "/v1/current/claude", { key: admin }));
    expect(res.status).toBe(404);

    res = await handle(req("PUT", "/v1/current/claude", { key: admin, body: { name: "alice" } }));
    expect(res.status).toBe(200);

    // delete
    res = await handle(req("DELETE", "/v1/accounts/claude/alice", { key: admin }));
    expect(res.status).toBe(204);
    res = await handle(req("GET", "/v1/accounts/claude/alice", { key: admin }));
    expect(res.status).toBe(404);
  });

  test("login cleanup conditionally removes only the exact unchanged account created by that operation", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    const createdResponse = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "failed-login", tool: "codex", dir: "/tmp/failed-login" },
    }));
    const created = await createdResponse.json() as Account;
    const expected = {
      cleanupOperationId: randomUUID(),
      cleanupRequestedAt: new Date().toISOString(),
      expectedIncarnationId: created.incarnationId,
      expectedCreatedAt: created.createdAt,
      expectedEmail: null,
      expectedDisplayName: null,
      expectedIdentity: null,
      expectedCardLast4: null,
      expectedMetadata: {},
      expectedDir: created.dir ?? null,
      expectedDescription: null,
      expectedLastUsedAt: null,
    };

    let cleanup = await handle(req("POST", "/v1/accounts/codex/failed-login/login/remove-created-operation", {
      key: admin,
      body: expected,
    }));
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toEqual({ removed: true, currentExists: false, expired: false });
    expect((await handle(req("GET", "/v1/accounts/codex/failed-login", { key: admin }))).status).toBe(404);
    cleanup = await handle(req("POST", "/v1/accounts/codex/failed-login/login/remove-created-operation", {
      key: admin,
      body: expected,
    }));
    expect(await cleanup.json()).toEqual({ removed: true, currentExists: false, expired: false });
    const recreatedResponse = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "failed-login", tool: "codex", dir: "/tmp/replacement-login" },
    }));
    expect(recreatedResponse.status).toBe(201);
    cleanup = await handle(req("POST", "/v1/accounts/codex/failed-login/login/remove-created-operation", {
      key: admin,
      body: expected,
    }));
    expect(await cleanup.json()).toEqual({ removed: true, currentExists: true, expired: false });
    expect((await handle(req("GET", "/v1/accounts/codex/failed-login", { key: admin }))).status).toBe(200);

    const replacementResponse = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "changed-login", tool: "codex", dir: "/tmp/changed-login" },
    }));
    const replacement = await replacementResponse.json() as Account;
    await handle(req("PATCH", "/v1/accounts/codex/changed-login", {
      key: admin,
      body: { description: "concurrent change" },
    }));
    cleanup = await handle(req("POST", "/v1/accounts/codex/changed-login/login/remove-created-operation", {
      key: admin,
      body: {
        ...expected,
        cleanupOperationId: randomUUID(),
        expectedIncarnationId: replacement.incarnationId,
        expectedCreatedAt: replacement.createdAt,
        expectedDir: replacement.dir ?? null,
      },
    }));
    expect(await cleanup.json()).toEqual({ removed: false, currentExists: true, expired: false });
    expect((await handle(req("GET", "/v1/accounts/codex/changed-login", { key: admin }))).status).toBe(200);

    const selectedResponse = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "selected-login", tool: "codex", dir: "/tmp/selected-login" },
    }));
    const selected = await selectedResponse.json() as Account;
    await handle(req("PUT", "/v1/current/codex", {
      key: admin,
      body: { name: selected.name },
    }));
    const selectedAfterActivation = await (
      await handle(req("GET", "/v1/accounts/codex/selected-login", { key: admin }))
    ).json() as Account;
    cleanup = await handle(req("POST", "/v1/accounts/codex/selected-login/login/remove-created-operation", {
      key: admin,
      body: {
        ...expected,
        cleanupOperationId: randomUUID(),
        expectedIncarnationId: selected.incarnationId,
        expectedCreatedAt: selected.createdAt,
        expectedDir: selected.dir ?? null,
        expectedLastUsedAt: selectedAfterActivation.lastUsedAt ?? null,
      },
    }));
    expect(await cleanup.json()).toEqual({ removed: false, currentExists: true, expired: false });
    expect((await handle(req("GET", "/v1/current/codex", { key: admin }))).status).toBe(200);
  });

  test("login update returns the documented 409 when the account incarnation changes", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    const originalResponse = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "recreated-login", tool: "claude", email: "original@example.com" },
    }));
    const original = await originalResponse.json() as Account;
    expect((await handle(req("DELETE", "/v1/accounts/claude/recreated-login", { key: admin }))).status).toBe(204);
    const replacementResponse = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "recreated-login", tool: "claude", email: "replacement@example.com" },
    }));
    const replacement = await replacementResponse.json() as Account;
    expect(replacement.incarnationId).not.toBe(original.incarnationId);

    const conflict = await handle(req("PATCH", "/v1/accounts/claude/recreated-login/login/update", {
      key: admin,
      body: {
        expectedIncarnationId: original.incarnationId,
        expectedEmail: "original@example.com",
        email: "stale-finalizer@example.com",
      },
    }));

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "profile changed while login finalization was in progress",
    });
    const current = await handle(req("GET", "/v1/accounts/claude/recreated-login", { key: admin }));
    expect((await current.json()).email).toBe("replacement@example.com");
    const operation = buildOpenApiDoc("test").paths["/v1/accounts/{tool}/{name}/login/update"] as {
      patch: { responses: Record<string, unknown> };
    };
    expect(operation.patch.responses["409"]).toBeDefined();
  });

  test("transactional login create is new-only and replays one exact incarnation", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    const expectedIncarnationId = randomUUID();
    const body = {
      name: "login-create",
      tool: "codex",
      dir: "/tmp/login-create",
      expectedIncarnationId,
    };

    const first = await handle(req("POST", "/v1/accounts/login/create", { key: admin, body }));
    const created = await first.json() as Account;
    const replay = await handle(req("POST", "/v1/accounts/login/create", { key: admin, body }));
    const replayed = await replay.json() as Account;

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(created.incarnationId).toBe(expectedIncarnationId);
    expect(replayed).toEqual(created);
  });

  test("validation errors return 400", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(
      req("POST", "/v1/accounts", { key: key(["accounts:write"]), body: { name: "BAD NAME", tool: "claude" } }),
    );
    expect(res.status).toBe(400);
  });

  test("legacy current rollback requests remain accepted during server rollout", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "legacy", tool: "claude" },
    }));
    await handle(req("PUT", "/v1/current/claude", {
      key: admin,
      body: { name: "legacy" },
    }));
    const res = await handle(req("POST", "/v1/current/claude/restore", {
      key: admin,
      body: { expectedName: "legacy" },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: true });
  });

  test("legacy current rollback route rejects transactional ownership fields", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    const createdResponse = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "legacy-isolated", tool: "claude" },
    }));
    const created = await createdResponse.json();
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const activated = await handle(req("PUT", "/v1/current/claude/login/activate", {
      key: admin,
      body: { name: "legacy-isolated", operationId, expectedIncarnationId: created.incarnationId },
    }));
    const selection = await activated.json() as LoginCurrentSelection;

    for (const transactionalField of [
      { expectedRevision: selection.revision },
      { expectedOperationId: operationId },
      { restoreLastUsedAt: null },
    ]) {
      const res = await handle(req("POST", "/v1/current/claude/restore", {
        key: admin,
        body: { expectedName: "legacy-isolated", ...transactionalField },
      }));
      expect(res.status).toBe(400);
      const current = await handle(req("GET", "/v1/current/claude", { key: admin }));
      expect((await current.json()).name).toBe("legacy-isolated");
    }
  });

  test("transactional login activation returns the committed rollback generation", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    const createdResponse = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "login-target", tool: "claude" },
    }));
    const created = await createdResponse.json();
    const operationId = "11111111-1111-4111-8111-111111111111";
    const res = await handle(req("PUT", "/v1/current/claude/login/activate", {
      key: admin,
      body: { name: "login-target", operationId, expectedIncarnationId: created.incarnationId },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tool: "claude",
      name: "login-target",
      operationId,
      revision: expect.any(String),
    });
    const restored = await handle(req("POST", "/v1/current/claude/login/restore", {
      key: admin,
      body: {
        expectedName: "login-target",
        expectedOperationId: operationId,
        restoreLastUsedAt: null,
      },
    }));
    expect(await restored.json()).toEqual({ restored: true });
    const account = await handle(req("GET", "/v1/accounts/claude/login-target", { key: admin }));
    expect((await account.json()).lastUsedAt).toBeUndefined();
  });

  test("revision-based login rollback conditionally restores lastUsedAt", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "revision-target", tool: "claude" },
    }));
    const activation = await handle(req("PUT", "/v1/current/claude", {
      key: admin,
      body: { name: "revision-target" },
    }));
    const selection = await activation.json() as CurrentSelection;

    const restored = await handle(req("POST", "/v1/current/claude/login/restore", {
      key: admin,
      body: {
        expectedName: "revision-target",
        expectedRevision: selection.revision,
        restoreLastUsedAt: null,
      },
    }));

    expect(await restored.json()).toEqual({ restored: true });
    const account = await handle(req("GET", "/v1/accounts/claude/revision-target", { key: admin }));
    expect((await account.json()).lastUsedAt).toBeUndefined();
  });

  test("out-of-range current revisions are rejected before reaching PostgreSQL", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    const res = await handle(req("POST", "/v1/current/claude/login/restore", {
      key: admin,
      body: {
        expectedName: "revision-target",
        expectedRevision: "9223372036854775808",
      },
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "expectedRevision: expectedRevision must fit a PostgreSQL bigint" });
  });

  test("transactional login retry is a no-op after a newer current selection", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    let targetIncarnationId = "";
    for (const name of ["login-target", "newer"]) {
      const createdResponse = await handle(req("POST", "/v1/accounts", {
        key: admin,
        body: { name, tool: "claude" },
      }));
      const created = await createdResponse.json();
      if (name === "login-target") targetIncarnationId = created.incarnationId;
    }
    const operationId = "22222222-2222-4222-8222-222222222222";
    const first = await handle(req("PUT", "/v1/current/claude/login/activate", {
      key: admin,
      body: { name: "login-target", operationId, expectedIncarnationId: targetIncarnationId },
    }));
    const firstBody = await first.json();
    await handle(req("PUT", "/v1/current/claude", {
      key: admin,
      body: { name: "newer" },
    }));
    const retry = await handle(req("PUT", "/v1/current/claude/login/activate", {
      key: admin,
      body: { name: "login-target", operationId, expectedIncarnationId: targetIncarnationId },
    }));
    expect(await retry.json()).toEqual(firstBody);
    const current = await handle(req("GET", "/v1/current/claude", { key: admin }));
    expect((await current.json()).name).toBe("newer");
  });

  test("transactional login retry rejects a replacement target incarnation", async () => {
    const handle = createHandler(makeCtx());
    const admin = key(["accounts:*"]);
    const created = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "replay-target", tool: "claude" },
    }));
    const original = await created.json();
    const operationId = "33333333-3333-4333-8333-333333333333";
    const activated = await handle(req("PUT", "/v1/current/claude/login/activate", {
      key: admin,
      body: {
        name: "replay-target",
        operationId,
        expectedIncarnationId: original.incarnationId,
      },
    }));
    expect(activated.status).toBe(200);
    expect((await handle(req("DELETE", "/v1/accounts/claude/replay-target", { key: admin }))).status).toBe(204);
    const recreated = await handle(req("POST", "/v1/accounts", {
      key: admin,
      body: { name: "replay-target", tool: "claude" },
    }));
    const replacement = await recreated.json();

    const replay = await handle(req("PUT", "/v1/current/claude/login/activate", {
      key: admin,
      body: {
        name: "replay-target",
        operationId,
        expectedIncarnationId: replacement.incarnationId,
      },
    }));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({
      error: "login operation id is already bound to another profile incarnation",
    });
    expect((await handle(req("GET", "/v1/current/claude", { key: admin }))).status).toBe(404);
  });

  test("POST /v1/accounts/:tool/:name/rename renames and keeps current selection", async () => {
    const ctx = makeCtx();
    const handle = createHandler(ctx);
    await handle(req("POST", "/v1/accounts", { key: key(["accounts:write"]), body: { name: "personal", tool: "claude" } }));
    await handle(req("PUT", "/v1/current/claude", { key: key(["accounts:write"]), body: { name: "personal" } }));
    const res = await handle(
      req("POST", "/v1/accounts/claude/personal/rename", { key: key(["accounts:write"]), body: { name: "home" } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("home");
    const current = await handle(req("GET", "/v1/current/claude", { key: key(["accounts:read"]) }));
    expect((await current.json()).name).toBe("home");
  });

  test("rename requires accounts:write scope", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(
      req("POST", "/v1/accounts/claude/personal/rename", { key: key(["accounts:read"]), body: { name: "home" } }),
    );
    expect(res.status).toBe(403);
  });

  test("rename of a missing profile returns 404", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(
      req("POST", "/v1/accounts/claude/ghost/rename", { key: key(["accounts:write"]), body: { name: "home" } }),
    );
    expect(res.status).toBe(404);
  });

  test("unknown route returns 404", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(req("GET", "/nope"));
    expect(res.status).toBe(404);
  });

  test("GET /v1/tools lists builtin tools", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(req("GET", "/v1/tools", { key: key(["accounts:read"]) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.some((t: any) => t.id === "claude")).toBe(true);
  });

  test("Tool response remains additive for old clients", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(req("GET", "/v1/tools", { key: key(["accounts:read"]) }));
    const body = await res.json();
    const oldClientView = body.tools.map((tool: { id: string; label: string }) => ({
      id: tool.id,
      label: tool.label,
    }));
    expect(oldClientView.some((tool: { id: string }) => tool.id === "claude")).toBe(true);
    const schema = buildOpenApiDoc("test").components.schemas.Tool;
    expect(schema.required).toEqual(["id", "label"]);
  });

  const customToolDef = {
    id: "acme",
    label: "Acme",
    envVar: "ACME_HOME",
    defaultDir: "/home/x/.acme",
    bin: "acme",
  };

  test("POST /v1/tools registers a custom tool that GET then returns", async () => {
    const handle = createHandler(makeCtx());
    const created = await handle(
      req("POST", "/v1/tools", { key: key(["accounts:write"]), body: customToolDef }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.id).toBe("acme");
    expect(createdBody.builtin).toBe(false);

    const list = await handle(req("GET", "/v1/tools", { key: key(["accounts:read"]) }));
    const body = await list.json();
    const acme = body.tools.find((t: any) => t.id === "acme");
    expect(acme).toBeDefined();
    expect(acme.builtin).toBe(false);
    expect(acme.bin).toBe("acme");
  });

  test("POST /v1/tools rejects a built-in id with 409", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(
      req("POST", "/v1/tools", { key: key(["accounts:write"]), body: { ...customToolDef, id: "claude" } }),
    );
    expect(res.status).toBe(409);
  });

  test("POST /v1/tools requires write scope", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(
      req("POST", "/v1/tools", { key: key(["accounts:read"]), body: customToolDef }),
    );
    expect(res.status).toBe(403);
  });

  test("DELETE /v1/tools/:id removes a custom tool", async () => {
    const handle = createHandler(makeCtx());
    await handle(req("POST", "/v1/tools", { key: key(["accounts:write"]), body: customToolDef }));
    const del = await handle(req("DELETE", "/v1/tools/acme", { key: key(["accounts:write"]) }));
    expect(del.status).toBe(204);
    const missing = await handle(req("DELETE", "/v1/tools/acme", { key: key(["accounts:write"]) }));
    expect(missing.status).toBe(404);
  });

  test("DELETE /v1/tools/:id rejects a built-in id with 409", async () => {
    const handle = createHandler(makeCtx());
    const res = await handle(req("DELETE", "/v1/tools/claude", { key: key(["accounts:write"]) }));
    expect(res.status).toBe(409);
  });
});
