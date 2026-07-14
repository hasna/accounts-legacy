import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import {
  createQueryClient,
  MigrationLedger,
  type PoolQueryClient,
} from "../generated/storage-kit/index.js";
import {
  accountsMigrations,
  assertMigrationStatusCompatible,
  readMigrationStatus,
} from "./migrations.js";
import { AccountsRepo } from "./repo.js";
import { createHandler, type ServiceContext } from "./app.js";

const DATABASE_URL = process.env.HASNA_ACCOUNTS_TEST_DATABASE_URL;

if (process.env.ACCOUNTS_REQUIRE_POSTGRES === "1" && !DATABASE_URL) {
  test("PostgreSQL integration requires an explicit test database", () => {
    throw new Error(
      "Set HASNA_ACCOUNTS_TEST_DATABASE_URL to an isolated PostgreSQL database; no service was started automatically.",
    );
  });
}

const describePostgres = DATABASE_URL ? describe : describe.skip;

describePostgres("PostgreSQL migration and repository integration", () => {
  const signingSecret = "postgres-integration-signing-secret";
  const schema = "accounts_it_" + randomBytes(6).toString("hex");
  let adminPool: Pool;
  let client: PoolQueryClient;

  function openClient(applicationName = "accounts-postgres-integration"): PoolQueryClient {
    const pool = new Pool({
      connectionString: DATABASE_URL,
      options: "-c search_path=" + schema,
      application_name: applicationName,
      max: 2,
    });
    return createQueryClient(pool);
  }

  async function waitForAdvisoryWait(applicationName: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await adminPool.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND application_name = $1
             AND wait_event = 'advisory'
         ) AS waiting`,
        [applicationName],
      );
      if (waiting.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for advisory lock: ${applicationName}`);
  }

  async function runOrderedToolRace<T, U>(
    tool: string,
    firstName: string,
    first: () => Promise<T>,
    secondName: string,
    second: () => Promise<U>,
  ): Promise<[PromiseSettledResult<T>, PromiseSettledResult<U>]> {
    const blocker = openClient(`blocker-${tool}`);
    let releaseLock!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const held = blocker.transaction(async (tx) => {
      await tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`accounts:tool:${tool}`],
      );
      signalLocked();
      await released;
    });

    try {
      await locked;
      const firstPromise = first();
      await waitForAdvisoryWait(firstName);
      const secondPromise = second();
      await waitForAdvisoryWait(secondName);
      releaseLock();
      await held;
      return await Promise.allSettled([firstPromise, secondPromise]);
    } finally {
      releaseLock();
      await held.catch(() => {});
      await blocker.close();
    }
  }

  function createLiveHandler(repo: AccountsRepo): (request: Request) => Promise<Response> {
    const context: ServiceContext = {
      repo,
      verifier: verifyApiKey({ app: "accounts", signingSecret }),
      health: async () => ({ ok: true }),
      ready: async () => ({ ready: true }),
      mode: "cloud",
      version: "postgres-integration",
      close: async () => {},
    };
    return createHandler(context);
  }

  function oldClientCreateRequest(tool: string, name: string): Request {
    const token = mintApiKey({
      app: "accounts",
      scopes: ["accounts:write"],
      signingSecret,
    }).token;
    return new Request("http://localhost/v1/accounts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": token,
      },
      body: JSON.stringify({ tool, name }),
    });
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    client = openClient();
  });

  afterAll(async () => {
    await client?.close();
    await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  test("migrations 0003/0004/0005 upgrade existing data and are restart-idempotent", async () => {
    const appMigrations = accountsMigrations().filter((migration) =>
      migration.id.startsWith("accounts_"),
    );
    const customToolsIndex = appMigrations.findIndex(
      (migration) => migration.id === "accounts_0003_custom_tools",
    );
    const beforeCustomTools = appMigrations.slice(0, customToolsIndex);

    await new MigrationLedger(client, beforeCustomTools).migrate();
    expect(
      await client.get<{ table_name: string | null }>(
        "SELECT to_regclass('custom_tools')::text AS table_name",
      ),
    ).toEqual({ table_name: null });

    await client.execute(
      "INSERT INTO accounts (tool, name) VALUES ($1, $2)",
      ["migration-probe", "valid"],
    );
    await client.execute(
      "INSERT INTO current_selections (tool, name) VALUES ($1, $2), ($3, $4)",
      ["migration-probe", "valid", "migration-orphan", "missing"],
    );

    const upgraded = await new MigrationLedger(client, appMigrations).migrate();
    expect(
      upgraded.plan.find((item) => item.migration.id === "accounts_0003_custom_tools")?.state,
    ).toBe("pending");
    expect(
      await client.get<{ table_name: string | null }>(
        "SELECT to_regclass('custom_tools')::text AS table_name",
      ),
    ).toEqual({ table_name: "custom_tools" });
    expect(
      await client.get<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'current_selections_account_fk'
             AND conrelid = 'current_selections'::regclass
         ) AS present`,
      ),
    ).toEqual({ present: true });
    expect(
      await client.get<{ table_name: string | null }>(
        "SELECT to_regclass('custom_tool_tombstones')::text AS table_name",
      ),
    ).toEqual({ table_name: "custom_tool_tombstones" });
    expect(
      await client.many<{ tool: string; name: string }>(
        "SELECT tool, name FROM current_selections WHERE tool LIKE 'migration-%' ORDER BY tool",
      ),
    ).toEqual([{ tool: "migration-probe", name: "valid" }]);
    expect(
      await client.many<{ tool: string; name: string; reason: string }>(
        "SELECT tool, name, reason FROM current_selection_orphan_archive ORDER BY tool",
      ),
    ).toEqual([
      {
        tool: "migration-orphan",
        name: "missing",
        reason: "missing account during migration 0004",
      },
    ]);

    await client.close();
    client = openClient();
    const restarted = await new MigrationLedger(client, appMigrations).migrate();
    expect(restarted.plan.every((item) => item.state === "already_applied")).toBe(true);
    expect((await readMigrationStatus(client, appMigrations)).pending).toEqual([]);
    expect(
      await client.get<{ count: number }>(
        "SELECT count(*)::int AS count FROM current_selection_orphan_archive",
      ),
    ).toEqual({ count: 1 });

    const tombstoneMigration = appMigrations.find(
      (migration) => migration.id === "accounts_0005_custom_tool_tombstones",
    );
    expect(tombstoneMigration).toBeDefined();
    await client.execute(tombstoneMigration!.sql);
    expect(
      await client.get<{ table_name: string | null }>(
        "SELECT to_regclass('custom_tool_tombstones')::text AS table_name",
      ),
    ).toEqual({ table_name: "custom_tool_tombstones" });
  });

  test("legacy migrator is downgrade-guarded; app rollback keeps the new migrator", async () => {
    await client.execute(
      "INSERT INTO accounts (tool, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["rollback-probe", "old-server"],
    );
    expect(
      await client.get<{ table_name: string | null }>(
        "SELECT to_regclass('custom_tools')::text AS table_name",
      ),
    ).toEqual({ table_name: "custom_tools" });
    const appMigrations = accountsMigrations().filter((migration) => migration.id.startsWith("accounts_"));
    const customToolsIndex = appMigrations.findIndex(
      (migration) => migration.id === "accounts_0003_custom_tools",
    );
    const legacyMigrations = appMigrations.slice(0, customToolsIndex);
    const legacyStatus = await readMigrationStatus(client, legacyMigrations);
    expect(legacyStatus.pending).toEqual([]);
    expect(legacyStatus.unknown).toEqual([
      "accounts_0003_custom_tools",
      "accounts_0004_current_selection_account_fk",
      "accounts_0005_custom_tool_tombstones",
    ]);
    expect(() => assertMigrationStatusCompatible(legacyStatus)).toThrow(
      /not recognized by this build \(downgrade\?\)/,
    );
    await expect(
      new MigrationLedger(client, legacyMigrations).migrate({ dryRun: true }),
    ).rejects.toThrow(/not recognized by this build \(downgrade\?\)/);

    const forward = await new MigrationLedger(client, appMigrations).migrate();
    expect(forward.plan.every((item) => item.state === "already_applied")).toBe(true);
    expect((await readMigrationStatus(client, appMigrations)).pending).toEqual([]);

    await client.execute(
      `INSERT INTO custom_tools (id, definition)
       VALUES ($1, $2::jsonb)`,
      [
        "rollback-custom",
        JSON.stringify({
          id: "rollback-custom",
          label: "Rollback Custom",
          envVar: "ROLLBACK_CUSTOM_HOME",
          defaultDir: "/tmp/rollback-custom",
          bin: "rollback-custom",
        }),
      ],
    );
    await client.execute("DELETE FROM custom_tools WHERE id = $1", ["rollback-custom"]);
    expect(
      await client.get<{ id: string }>(
        "SELECT id FROM custom_tool_tombstones WHERE id = $1",
        ["rollback-custom"],
      ),
    ).toEqual({ id: "rollback-custom" });
    await expect(
      client.execute(
        "INSERT INTO accounts (tool, name) VALUES ($1, $2)",
        ["rollback-custom", "old-server-create"],
      ),
    ).rejects.toThrow('custom tool "rollback-custom" was explicitly removed');
  });

  test("rename and remove roll back account changes when current-selection updates fail", async () => {
    const repo = new AccountsRepo(client);
    await repo.create({ tool: "claude", name: "old" });
    await repo.setCurrent("claude", "old");
    await client.execute(`
      CREATE FUNCTION fail_current_selection_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced current selection failure';
      END;
      $$
    `);
    await client.execute(`
      CREATE TRIGGER fail_current_selection_change
      BEFORE UPDATE OR DELETE ON current_selections
      FOR EACH ROW EXECUTE FUNCTION fail_current_selection_change()
    `);

    try {
      await expect(repo.rename("claude", "old", "new")).rejects.toThrow(
        "forced current selection failure",
      );
      expect((await repo.get("claude", "old"))?.name).toBe("old");
      expect(await repo.get("claude", "new")).toBeNull();
      expect((await repo.getCurrent("claude"))?.name).toBe("old");

      await expect(repo.remove("claude", "old")).rejects.toThrow(
        "forced current selection failure",
      );
      expect((await repo.get("claude", "old"))?.name).toBe("old");
      expect((await repo.getCurrent("claude"))?.name).toBe("old");
    } finally {
      await client.execute("DROP TRIGGER IF EXISTS fail_current_selection_change ON current_selections");
      await client.execute("DROP FUNCTION IF EXISTS fail_current_selection_change()");
    }
  });

  test("foreign key rejects orphan current selections", async () => {
    await expect(
      client.execute(
        "INSERT INTO current_selections (tool, name) VALUES ($1, $2)",
        ["missing-tool", "missing-profile"],
      ),
    ).rejects.toThrow(/foreign key constraint/);
  });

  test("setCurrent serializes with concurrent rename and remove", async () => {
    const second = openClient();
    try {
      const firstRepo = new AccountsRepo(client);
      const secondRepo = new AccountsRepo(second);

      await firstRepo.addCustomTool({
        id: "race",
        label: "Race",
        envVar: "RACE_HOME",
        defaultDir: "/tmp/race",
        bin: "race",
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const oldName = `rename-old-${attempt}`;
        const newName = `rename-new-${attempt}`;
        await firstRepo.create({ tool: "race", name: oldName });
        await firstRepo.setCurrent("race", oldName);
        const [setResult, renameResult] = await Promise.allSettled([
          firstRepo.setCurrent("race", oldName),
          secondRepo.rename("race", oldName, newName),
        ]);
        expect(renameResult.status).toBe("fulfilled");
        if (setResult.status === "rejected") {
          expect(String(setResult.reason)).toContain(`no profile named "${oldName}"`);
        }
        expect((await firstRepo.getCurrent("race"))?.name).toBe(newName);
        expect(await firstRepo.get("race", oldName)).toBeNull();
        expect((await firstRepo.get("race", newName))?.name).toBe(newName);
      }

      await firstRepo.addCustomTool({
        id: "remove-race",
        label: "Remove Race",
        envVar: "REMOVE_RACE_HOME",
        defaultDir: "/tmp/remove-race",
        bin: "remove-race",
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const name = `remove-${attempt}`;
        await firstRepo.create({ tool: "remove-race", name });
        await firstRepo.setCurrent("remove-race", name);
        const [setResult, removeResult] = await Promise.allSettled([
          firstRepo.setCurrent("remove-race", name),
          secondRepo.remove("remove-race", name),
        ]);
        expect(removeResult).toEqual({ status: "fulfilled", value: true });
        if (setResult.status === "rejected") {
          expect(String(setResult.reason)).toContain(`no profile named "${name}"`);
        }
        expect(await firstRepo.getCurrent("remove-race")).toBeNull();
        expect(await firstRepo.get("remove-race", name)).toBeNull();
      }
    } finally {
      await second.close();
    }
  });

  test("unseen legacy custom tool IDs remain valid for old-client account creation", async () => {
    const repo = new AccountsRepo(client);
    const response = await createLiveHandler(repo)(
      oldClientCreateRequest("legacy-unseen", "profile"),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      tool: "legacy-unseen",
      name: "profile",
    });
    expect(
      await client.get<{ id: string }>(
        "SELECT id FROM custom_tools WHERE id = $1",
        ["legacy-unseen"],
      ),
    ).toBeNull();
    expect(
      await client.get<{ id: string }>(
        "SELECT id FROM custom_tool_tombstones WHERE id = $1",
        ["legacy-unseen"],
      ),
    ).toBeNull();
  });

  test("explicit removal durably rejects later account creation", async () => {
    const repo = new AccountsRepo(client);
    expect(await repo.removeCustomTool("legacy-removed")).toBe(false);
    expect(
      await client.get<{ id: string }>(
        "SELECT id FROM custom_tool_tombstones WHERE id = $1",
        ["legacy-removed"],
      ),
    ).toEqual({ id: "legacy-removed" });
    const response = await createLiveHandler(repo)(
      oldClientCreateRequest("legacy-removed", "profile"),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'custom tool "legacy-removed" was explicitly removed',
    });
    expect(await repo.get("legacy-removed", "profile")).toBeNull();

    await repo.addCustomTool({
      id: "legacy-removed",
      label: "Legacy Reactivated",
      envVar: "LEGACY_REACTIVATED_HOME",
      defaultDir: "/tmp/legacy-reactivated",
      bin: "legacy-reactivated",
    });
    expect(
      await client.get<{ id: string }>(
        "SELECT id FROM custom_tool_tombstones WHERE id = $1",
        ["legacy-removed"],
      ),
    ).toBeNull();
    const reactivated = await createLiveHandler(repo)(
      oldClientCreateRequest("legacy-removed", "reactivated"),
    );
    expect(reactivated.status).toBe(201);
  });

  test("custom-tool removal and account creation serialize in both orderings", async () => {
    const createFirstClient = openClient("race-create-first");
    const removeSecondClient = openClient("race-remove-second");
    const removeFirstClient = openClient("race-remove-first");
    const createSecondClient = openClient("race-create-second");
    try {
      const createFirstRepo = new AccountsRepo(createFirstClient);
      const removeSecondRepo = new AccountsRepo(removeSecondClient);
      const [created, removeAfterCreate] = await runOrderedToolRace(
        "legacy-create-first",
        "race-create-first",
        () => createFirstRepo.create({ tool: "legacy-create-first", name: "profile" }),
        "race-remove-second",
        () => removeSecondRepo.removeCustomTool("legacy-create-first"),
      );
      expect(created.status).toBe("fulfilled");
      expect(removeAfterCreate.status).toBe("rejected");
      expect(String(removeAfterCreate.status === "rejected" ? removeAfterCreate.reason : "")).toContain(
        "still used by profile(s) profile",
      );
      expect((await createFirstRepo.get("legacy-create-first", "profile"))?.name).toBe("profile");
      expect(
        await client.get("SELECT id FROM custom_tool_tombstones WHERE id = $1", ["legacy-create-first"]),
      ).toBeNull();

      const seedRepo = new AccountsRepo(client);
      await seedRepo.addCustomTool({
        id: "legacy-remove-first",
        label: "Legacy Remove First",
        envVar: "LEGACY_REMOVE_FIRST_HOME",
        defaultDir: "/tmp/legacy-remove-first",
        bin: "legacy-remove-first",
      });
      const removeFirstRepo = new AccountsRepo(removeFirstClient);
      const createSecondRepo = new AccountsRepo(createSecondClient);
      const [removed, createAfterRemove] = await runOrderedToolRace(
        "legacy-remove-first",
        "race-remove-first",
        () => removeFirstRepo.removeCustomTool("legacy-remove-first"),
        "race-create-second",
        () => createSecondRepo.create({ tool: "legacy-remove-first", name: "profile" }),
      );
      expect(removed).toEqual({ status: "fulfilled", value: true });
      expect(createAfterRemove.status).toBe("rejected");
      expect(String(createAfterRemove.status === "rejected" ? createAfterRemove.reason : "")).toContain(
        'custom tool "legacy-remove-first" was explicitly removed',
      );
      expect(await createSecondRepo.get("legacy-remove-first", "profile")).toBeNull();
      expect(
        await client.get<{ id: string }>(
          "SELECT id FROM custom_tool_tombstones WHERE id = $1",
          ["legacy-remove-first"],
        ),
      ).toEqual({ id: "legacy-remove-first" });
    } finally {
      await Promise.all([
        createFirstClient.close(),
        removeSecondClient.close(),
        removeFirstClient.close(),
        createSecondClient.close(),
      ]);
    }
  });
});
