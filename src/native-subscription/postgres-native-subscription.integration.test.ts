import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { SQL } from "bun";
import { Pool } from "pg";

import type {
  CapsuleMaintenanceGrantReservation,
  CapsuleMaintenanceUseCommit,
} from "./capsule-maintenance.js";
import { PostgresCapsuleMaintenanceLedger } from "./postgres-capsule-maintenance.js";
import {
  POSTGRES_MIGRATIONS,
  POSTGRES_MIGRATION_CHECKSUM,
  POSTGRES_SCHEMA_VERSION,
} from "./postgres-migrations.js";
import { runPostgresMigrations } from "./postgres-migrator.js";
import { POSTGRES_SCHEMA_MANIFEST } from "./postgres-schema-manifest.js";
import {
  installPostgresRuntimeContext,
  type PostgresRuntimeRoleBoundary,
} from "./postgres-runtime.js";
import type { PostgresSqlClient, PostgresTransaction } from "./postgres-sql.js";

const DATABASE_URL = process.env.HASNA_ACCOUNTS_TEST_DATABASE_URL;

if (process.env.ACCOUNTS_REQUIRE_POSTGRES === "1" && !DATABASE_URL) {
  test("native-subscription PostgreSQL integration requires an explicit test database", () => {
    throw new Error(
      "Set HASNA_ACCOUNTS_TEST_DATABASE_URL to an isolated PostgreSQL database; no service was started automatically.",
    );
  });
}

const describePostgres = DATABASE_URL ? describe : describe.skip;

describePostgres("native-subscription PostgreSQL catalog and concurrency", () => {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `accounts_native_owner_${suffix}`;
  const runtimeRole = `accounts_native_runtime_${suffix}`;
  const loginRole = `accounts_native_login_${suffix}`;
  const directRole = `accounts_native_direct_${suffix}`;
  const ownerPassword = randomBytes(24).toString("hex");
  const loginPassword = randomBytes(24).toString("hex");
  const directPassword = randomBytes(24).toString("hex");
  const roleBoundary: PostgresRuntimeRoleBoundary = {
    mode: "set-role",
    roleName: runtimeRole,
    loginRoleName: loginRole,
  };
  const ownerA = "principal:service:hasna:native-integration-a";
  const ownerB = "principal:service:hasna:native-integration-b";
  const grantId = "018f0f00-1001-7000-8000-000000000001";
  const digest = (character: string) => `sha256:${character.repeat(64)}`;

  let admin: Pool;
  let ownerSql: SQL;
  let loginSql: SQL;
  let directSql: SQL;

  function roleUrl(role: string, password: string): string {
    const url = new URL(DATABASE_URL!);
    url.username = role;
    url.password = password;
    return url.toString();
  }

  function grant(): CapsuleMaintenanceGrantReservation {
    return {
      grantId,
      ownerRef: ownerA,
      idempotencyKeyDigest: digest("0"),
      requestDigest: digest("1"),
      reservationKeyDigest: digest("2"),
      grantDigest: digest("3"),
      grantBytes: Uint8Array.from(Buffer.from('{"grant":"live-concurrency"}')),
      expiresAt: "2030-07-18T12:10:00.000Z",
    };
  }

  function use(): CapsuleMaintenanceUseCommit {
    return {
      grantId,
      ownerRef: ownerA,
      idempotencyKeyDigest: digest("4"),
      requestDigest: digest("5"),
      maintenanceUseId: digest("6"),
      consumeReceiptDigest: digest("7"),
      consumeReceiptBytes: Uint8Array.from(Buffer.from('{"receipt":"live-concurrency"}')),
      committedAt: "2030-07-18T12:01:00.000Z",
    };
  }

  function identifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
  }

  async function resetAccountsSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS accounts CASCADE");
    await admin.query(
      `CREATE SCHEMA accounts AUTHORIZATION ${identifier(ownerRole)}`,
    );
  }

  async function createMigrationLedger(
    rows: readonly {
      readonly version: number;
      readonly checksum: string;
      readonly appliedAt?: string;
    }[],
  ): Promise<void> {
    await ownerSql`
      CREATE TABLE accounts.schema_migrations (
        version BIGINT PRIMARY KEY CHECK (version > 0),
        checksum TEXT NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `;
    for (const row of rows) {
      if (row.appliedAt === undefined) {
        await ownerSql`
          INSERT INTO accounts.schema_migrations(version, checksum)
          VALUES (${row.version}, ${row.checksum})
        `;
      } else {
        await ownerSql`
          INSERT INTO accounts.schema_migrations(version, checksum, applied_at)
          VALUES (${row.version}, ${row.checksum}, ${row.appliedAt}::timestamptz)
        `;
      }
    }
  }

  function observeMigrationSql(): {
    readonly client: PostgresSqlClient;
    readonly appliedSql: string[];
  } {
    const appliedSql: string[] = [];
    return {
      client: {
        begin: async (options, callback) =>
          ownerSql.begin(options, async (transaction) => {
            const tracked = Object.assign(
              (
                strings: TemplateStringsArray,
                ...values: unknown[]
              ) => transaction(strings, ...values),
              {
                unsafe: (statement: string) => {
                  appliedSql.push(statement);
                  return transaction.unsafe(statement);
                },
              },
            ) as unknown as PostgresTransaction;
            return callback(tracked);
          }),
      },
      appliedSql,
    };
  }

  async function expectSchemaDrift(
    mutations: readonly string[],
    restorations: readonly string[],
  ): Promise<void> {
    for (const mutation of mutations) await ownerSql.unsafe(mutation).simple();
    try {
      await expect(runPostgresMigrations(
        ownerSql as unknown as PostgresSqlClient,
        { runtimeRole: roleBoundary },
      )).rejects.toMatchObject({ code: "SCHEMA_CHECKSUM_MISMATCH" });
    } finally {
      for (const restoration of restorations) {
        await ownerSql.unsafe(restoration).simple();
      }
    }
    expect((await runPostgresMigrations(
      ownerSql as unknown as PostgresSqlClient,
      { runtimeRole: roleBoundary },
    )).appliedVersions).toEqual([]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(
      `CREATE ROLE "${ownerRole}" LOGIN PASSWORD '${ownerPassword}' ` +
        "NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    await admin.query(
      `CREATE ROLE "${runtimeRole}" NOLOGIN NOINHERIT NOSUPERUSER ` +
        "NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    await admin.query(
      `CREATE ROLE "${loginRole}" LOGIN PASSWORD '${loginPassword}' ` +
        "NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    await admin.query(
      `CREATE ROLE "${directRole}" LOGIN PASSWORD '${directPassword}' ` +
        "NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    await admin.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    await admin.query(`CREATE SCHEMA accounts AUTHORIZATION "${ownerRole}"`);
    ownerSql = new SQL(roleUrl(ownerRole, ownerPassword), { max: 2 });
    loginSql = new SQL(roleUrl(loginRole, loginPassword), { max: 8 });
    directSql = new SQL(roleUrl(directRole, directPassword), { max: 2 });
  });

  afterAll(async () => {
    await loginSql?.close({ timeout: 1 });
    await directSql?.close({ timeout: 1 });
    await ownerSql?.close({ timeout: 1 });
    await admin?.query("DROP SCHEMA IF EXISTS accounts CASCADE");
    await admin?.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    await admin?.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    await admin?.query(`DROP ROLE IF EXISTS "${directRole}"`);
    await admin?.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
    await admin?.end();
  });

  test("preflights invalid ledgers before SQL and applies a valid prefix", async () => {
    await ownerSql`CREATE TABLE accounts.residual_marker (id BIGINT PRIMARY KEY)`;
    let observed = observeMigrationSql();
    await expect(runPostgresMigrations(
      observed.client,
      { runtimeRole: roleBoundary },
    )).rejects.toMatchObject({ code: "SCHEMA_CHECKSUM_MISMATCH" });
    expect(observed.appliedSql).toEqual([]);

    await resetAccountsSchema();
    await createMigrationLedger([]);
    observed = observeMigrationSql();
    await expect(runPostgresMigrations(
      observed.client,
      { runtimeRole: roleBoundary },
    )).rejects.toMatchObject({ code: "SCHEMA_CHECKSUM_MISMATCH" });
    expect(observed.appliedSql).toEqual([]);

    await resetAccountsSchema();
    await createMigrationLedger([
      POSTGRES_MIGRATIONS[0],
      POSTGRES_MIGRATIONS[2],
    ]);
    observed = observeMigrationSql();
    await expect(runPostgresMigrations(
      observed.client,
      { runtimeRole: roleBoundary },
    )).rejects.toMatchObject({ code: "SCHEMA_CHECKSUM_MISMATCH" });
    expect(observed.appliedSql).toEqual([]);

    await resetAccountsSchema();
    await createMigrationLedger([
      POSTGRES_MIGRATIONS[1],
      POSTGRES_MIGRATIONS[0],
    ]);
    observed = observeMigrationSql();
    await expect(runPostgresMigrations(
      observed.client,
      { runtimeRole: roleBoundary },
    )).rejects.toMatchObject({ code: "SCHEMA_CHECKSUM_MISMATCH" });
    expect(observed.appliedSql).toEqual([]);

    await resetAccountsSchema();
    const appliedAt = "2030-07-18T12:00:00.000Z";
    await createMigrationLedger([
      { ...POSTGRES_MIGRATIONS[1], appliedAt },
      { ...POSTGRES_MIGRATIONS[0], appliedAt },
    ]);
    observed = observeMigrationSql();
    await expect(runPostgresMigrations(
      observed.client,
      { runtimeRole: roleBoundary },
    )).rejects.toMatchObject({ code: "SCHEMA_CHECKSUM_MISMATCH" });
    expect(observed.appliedSql).toEqual([]);

    await resetAccountsSchema();
    await ownerSql.unsafe(POSTGRES_MIGRATIONS[0].sql).simple();
    await ownerSql`
      INSERT INTO accounts.schema_migrations(version, checksum)
      VALUES (${POSTGRES_MIGRATIONS[0].version}, ${POSTGRES_MIGRATIONS[0].checksum})
    `;
    observed = observeMigrationSql();
    const prefixReport = await runPostgresMigrations(
      observed.client,
      { runtimeRole: roleBoundary },
    );
    expect(prefixReport.appliedVersions).toEqual(["2", "3", "4"]);
    expect(observed.appliedSql).not.toContain(POSTGRES_MIGRATIONS[0].sql);
    expect(observed.appliedSql).toContain(POSTGRES_MIGRATIONS[1].sql);
    expect(observed.appliedSql).toContain(POSTGRES_MIGRATIONS[2].sql);
    expect(observed.appliedSql).toContain(POSTGRES_MIGRATIONS[3].sql);

    await resetAccountsSchema();
  });

  test("serializes concurrent clean migration, replays the sequenced ledger, and uses SET ROLE", async () => {
    const reports = await Promise.all([
      runPostgresMigrations(
        ownerSql as unknown as PostgresSqlClient,
        { runtimeRole: roleBoundary },
      ),
      runPostgresMigrations(
        ownerSql as unknown as PostgresSqlClient,
        { runtimeRole: roleBoundary },
      ),
    ]);
    expect(reports.map((report) => report.appliedVersions.length).sort()).toEqual([
      0,
      POSTGRES_MIGRATIONS.length,
    ]);
    const first = reports.find((report) => report.appliedVersions.length > 0)!;
    const replay = reports.find((report) => report.appliedVersions.length === 0)!;
    expect(first).toEqual({
      schemaVersion: String(POSTGRES_SCHEMA_VERSION),
      migrationChecksum: POSTGRES_MIGRATION_CHECKSUM,
      appliedVersions: ["1", "2", "3", "4"],
      runtimeRole,
      runtimeRoleMode: "set-role",
    });
    expect(replay.appliedVersions).toEqual([]);
    expect(await ownerSql<Array<{
      version: string;
      ledger_sequence: string;
    }>>`
      SELECT
        version::text AS version,
        ledger_sequence::text AS ledger_sequence
      FROM accounts.schema_migrations
      ORDER BY ledger_sequence
    `).toEqual([
      { version: "1", ledger_sequence: "1" },
      { version: "2", ledger_sequence: "2" },
      { version: "3", ledger_sequence: "3" },
      { version: "4", ledger_sequence: "4" },
    ]);

    const context = await loginSql.begin("read only", async (transaction) => {
      await installPostgresRuntimeContext(transaction, {
        principalRef: ownerA,
        role: roleBoundary,
      });
      const [row] = await transaction<Array<{
        current_user: string;
        session_user: string;
      }>>`SELECT current_user, session_user`;
      return row;
    });
    expect(context).toEqual({ current_user: runtimeRole, session_user: loginRole });
  });

  test("serializes concurrent reserve/consume races and re-reads exact replay bytes", async () => {
    const first = new PostgresCapsuleMaintenanceLedger(
      loginSql as unknown as PostgresSqlClient,
      ownerA,
      roleBoundary,
    );
    const second = new PostgresCapsuleMaintenanceLedger(
      loginSql as unknown as PostgresSqlClient,
      ownerA,
      roleBoundary,
    );
    const reservations = await Promise.all([first.reserve(grant()), second.reserve(grant())]);
    expect(reservations.map((result) => result.status).sort()).toEqual([
      "replayed",
      "reserved",
    ]);
    for (const result of reservations) {
      if (result.status === "reserved" || result.status === "replayed") {
        expect(result.grantBytes).toEqual(grant().grantBytes);
      }
    }

    const consumptions = await Promise.all([first.consume(use()), second.consume(use())]);
    expect(consumptions.map((result) => result.status).sort()).toEqual([
      "consumed",
      "replayed",
    ]);
    for (const result of consumptions) {
      if (result.status === "consumed" || result.status === "replayed") {
        expect(result.consumeReceiptBytes).toEqual(use().consumeReceiptBytes);
      }
    }
  });

  test("enforces forced RLS isolation and append-only evidence at runtime", async () => {
    const otherOwner = new PostgresCapsuleMaintenanceLedger(
      loginSql as unknown as PostgresSqlClient,
      ownerB,
      roleBoundary,
    );
    expect((await otherOwner.consume({ ...use(), ownerRef: ownerB })).status).toBe("not_found");

    await expect(loginSql.begin("read write", async (transaction) => {
      await installPostgresRuntimeContext(transaction, {
        principalRef: ownerA,
        role: roleBoundary,
      });
      await transaction`
        UPDATE accounts.capsule_maintenance_uses
        SET request_digest = ${digest("8")}
        WHERE owner_ref = ${ownerA} AND grant_id = ${grantId}::uuid
      `;
    })).rejects.toThrow(/permission denied for table capsule_maintenance_uses/);

    await expect(admin.query(
      `UPDATE accounts.capsule_maintenance_uses
       SET request_digest = $1
       WHERE owner_ref = $2 AND grant_id = $3::uuid`,
      [digest("8"), ownerA, grantId],
    )).rejects.toThrow(/append-only Accounts row cannot be changed/);
  });

  test("detects catalog drift and rejects a newer ledger while preserving forward repair", async () => {
    await ownerSql`ALTER TABLE accounts.capsule_maintenance_grants NO FORCE ROW LEVEL SECURITY`;
    await expect(runPostgresMigrations(
      ownerSql as unknown as PostgresSqlClient,
      { runtimeRole: roleBoundary },
    )).rejects.toMatchObject({ code: "SCHEMA_CHECKSUM_MISMATCH" });
    await ownerSql`ALTER TABLE accounts.capsule_maintenance_grants FORCE ROW LEVEL SECURITY`;
    expect((await runPostgresMigrations(
      ownerSql as unknown as PostgresSqlClient,
      { runtimeRole: roleBoundary },
    )).appliedVersions).toEqual([]);

    await ownerSql`
      INSERT INTO accounts.schema_migrations(version, checksum)
      VALUES (999, ${digest("9")})
    `;
    await expect(runPostgresMigrations(
      ownerSql as unknown as PostgresSqlClient,
      { runtimeRole: roleBoundary },
    )).rejects.toMatchObject({ code: "SCHEMA_VERSION_UNSUPPORTED" });
    await ownerSql`ALTER TABLE accounts.schema_migrations
      DISABLE TRIGGER schema_migrations_immutable`;
    try {
      await ownerSql`DELETE FROM accounts.schema_migrations WHERE version = 999`;
    } finally {
      await ownerSql`ALTER TABLE accounts.schema_migrations
        ENABLE TRIGGER schema_migrations_immutable`;
    }
    expect((await runPostgresMigrations(
      ownerSql as unknown as PostgresSqlClient,
      { runtimeRole: roleBoundary },
    )).appliedVersions).toEqual([]);
  });

  test("rejects every dropped CAS and maintenance PK/UNIQUE/CHECK/FK invariant", async () => {
    const tables = new Set([
      "capability_use_consumptions",
      "capsule_maintenance_grants",
      "capsule_maintenance_uses",
    ]);
    const referencedUnique =
      "capsule_maintenance_grants_grant_id_owner_ref_key";
    const dependentForeignKey =
      "capsule_maintenance_uses_grant_id_owner_ref_fkey";
    const constraints = POSTGRES_SCHEMA_MANIFEST.constraints.filter(
      (entry) => tables.has(entry[0]),
    );

    for (const [tableName, constraintName, , definition] of constraints) {
      if (constraintName === referencedUnique) continue;
      await expectSchemaDrift(
        [
          `ALTER TABLE accounts.${identifier(tableName)} ` +
          `DROP CONSTRAINT ${identifier(constraintName)}`,
        ],
        [
          `ALTER TABLE accounts.${identifier(tableName)} ` +
          `ADD CONSTRAINT ${identifier(constraintName)} ${definition}`,
        ],
      );
    }

    const uniqueDefinition = constraints.find(
      (entry) => entry[1] === referencedUnique,
    )?.[3];
    const foreignKeyDefinition = constraints.find(
      (entry) => entry[1] === dependentForeignKey,
    )?.[3];
    expect(uniqueDefinition).toBeDefined();
    expect(foreignKeyDefinition).toBeDefined();
    await expectSchemaDrift(
      [
        `ALTER TABLE accounts.capsule_maintenance_uses ` +
        `DROP CONSTRAINT ${identifier(dependentForeignKey)}`,
        `ALTER TABLE accounts.capsule_maintenance_grants ` +
        `DROP CONSTRAINT ${identifier(referencedUnique)}`,
      ],
      [
        `ALTER TABLE accounts.capsule_maintenance_grants ` +
        `ADD CONSTRAINT ${identifier(referencedUnique)} ${uniqueDefinition}`,
        `ALTER TABLE accounts.capsule_maintenance_uses ` +
        `ADD CONSTRAINT ${identifier(dependentForeignKey)} ${foreignKeyDefinition}`,
      ],
    );
    expect(constraints).toHaveLength(27);
  });

  test("rejects altered column, collation, ordered-key, FK-action, check, and partial-index contracts", async () => {
    await expectSchemaDrift(
      [
        `ALTER TABLE accounts.capability_use_consumptions
         ALTER COLUMN committed_at DROP NOT NULL`,
      ],
      [
        `ALTER TABLE accounts.capability_use_consumptions
         ALTER COLUMN committed_at SET NOT NULL`,
      ],
    );
    await expectSchemaDrift(
      [
        `ALTER TABLE accounts.capsule_maintenance_grants
         ALTER COLUMN expires_at DROP NOT NULL`,
      ],
      [
        `ALTER TABLE accounts.capsule_maintenance_grants
         ALTER COLUMN expires_at SET NOT NULL`,
      ],
    );
    await expectSchemaDrift(
      [
        `ALTER TABLE accounts.capsule_maintenance_uses
         ALTER COLUMN committed_at DROP NOT NULL`,
      ],
      [
        `ALTER TABLE accounts.capsule_maintenance_uses
         ALTER COLUMN committed_at SET NOT NULL`,
      ],
    );
    await expectSchemaDrift(
      [
        `ALTER TABLE accounts.capability_use_consumptions
         ALTER COLUMN receipt_jcs_base64url TYPE text COLLATE "C"`,
      ],
      [
        `ALTER TABLE accounts.capability_use_consumptions
         ALTER COLUMN receipt_jcs_base64url TYPE text COLLATE "default"`,
      ],
    );

    const capabilityOrdinalConstraint =
      "capability_use_consumptions_owner_ref_capability_id_key";
    await expectSchemaDrift(
      [
        `ALTER TABLE accounts.capability_use_consumptions
         DROP CONSTRAINT ${identifier(capabilityOrdinalConstraint)}`,
        `ALTER TABLE accounts.capability_use_consumptions
         ADD CONSTRAINT ${identifier(capabilityOrdinalConstraint)}
         UNIQUE (capability_id, owner_ref)`,
      ],
      [
        `ALTER TABLE accounts.capability_use_consumptions
         DROP CONSTRAINT ${identifier(capabilityOrdinalConstraint)}`,
        `ALTER TABLE accounts.capability_use_consumptions
         ADD CONSTRAINT ${identifier(capabilityOrdinalConstraint)}
         UNIQUE (owner_ref, capability_id)`,
      ],
    );

    const capabilityDigestCheck =
      "capability_use_consumptions_request_digest_check";
    await expectSchemaDrift(
      [
        `ALTER TABLE accounts.capability_use_consumptions
         DROP CONSTRAINT ${identifier(capabilityDigestCheck)}`,
        `ALTER TABLE accounts.capability_use_consumptions
         ADD CONSTRAINT ${identifier(capabilityDigestCheck)}
         CHECK (request_digest LIKE 'sha256:%')`,
      ],
      [
        `ALTER TABLE accounts.capability_use_consumptions
         DROP CONSTRAINT ${identifier(capabilityDigestCheck)}`,
        `ALTER TABLE accounts.capability_use_consumptions
         ADD CONSTRAINT ${identifier(capabilityDigestCheck)}
         CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$')`,
      ],
    );

    const maintenanceUseForeignKey =
      "capsule_maintenance_uses_grant_id_owner_ref_fkey";
    await expectSchemaDrift(
      [
        `ALTER TABLE accounts.capsule_maintenance_uses
         DROP CONSTRAINT ${identifier(maintenanceUseForeignKey)}`,
        `ALTER TABLE accounts.capsule_maintenance_uses
         ADD CONSTRAINT ${identifier(maintenanceUseForeignKey)}
         FOREIGN KEY (grant_id, owner_ref)
         REFERENCES accounts.capsule_maintenance_grants(grant_id, owner_ref)
         ON DELETE CASCADE`,
      ],
      [
        `ALTER TABLE accounts.capsule_maintenance_uses
         DROP CONSTRAINT ${identifier(maintenanceUseForeignKey)}`,
        `ALTER TABLE accounts.capsule_maintenance_uses
         ADD CONSTRAINT ${identifier(maintenanceUseForeignKey)}
         FOREIGN KEY (grant_id, owner_ref)
         REFERENCES accounts.capsule_maintenance_grants(grant_id, owner_ref)
         ON DELETE RESTRICT`,
      ],
    );

    const reservationIndex = "capsule_maintenance_one_live_reservation";
    await expectSchemaDrift(
      [`DROP INDEX accounts.${identifier(reservationIndex)}`],
      [
        `CREATE UNIQUE INDEX ${identifier(reservationIndex)}
         ON accounts.capsule_maintenance_grants(owner_ref, reservation_key_digest)
         WHERE state = 'live'`,
      ],
    );
    await expectSchemaDrift(
      [
        `DROP INDEX accounts.${identifier(reservationIndex)}`,
        `CREATE UNIQUE INDEX ${identifier(reservationIndex)}
         ON accounts.capsule_maintenance_grants(reservation_key_digest, owner_ref)
         WHERE state = 'live'`,
      ],
      [
        `DROP INDEX accounts.${identifier(reservationIndex)}`,
        `CREATE UNIQUE INDEX ${identifier(reservationIndex)}
         ON accounts.capsule_maintenance_grants(owner_ref, reservation_key_digest)
         WHERE state = 'live'`,
      ],
    );
    await expectSchemaDrift(
      [
        `DROP INDEX accounts.${identifier(reservationIndex)}`,
        `CREATE UNIQUE INDEX ${identifier(reservationIndex)}
         ON accounts.capsule_maintenance_grants(owner_ref, reservation_key_digest)
         WHERE state IN ('live', 'expired')`,
      ],
      [
        `DROP INDEX accounts.${identifier(reservationIndex)}`,
        `CREATE UNIQUE INDEX ${identifier(reservationIndex)}
         ON accounts.capsule_maintenance_grants(owner_ref, reservation_key_digest)
         WHERE state = 'live'`,
      ],
    );
  });

  test("rolls back package SQL when runtime-role attestation fails", async () => {
    await ownerSql`DROP SCHEMA accounts CASCADE`;
    await admin.query(`CREATE SCHEMA accounts AUTHORIZATION "${ownerRole}"`);
    await expect(runPostgresMigrations(
      ownerSql as unknown as PostgresSqlClient,
      {
        runtimeRole: {
          mode: "direct",
          roleName: `missing_runtime_${suffix}`,
        },
      },
    )).rejects.toMatchObject({ code: "SCHEMA_CHECKSUM_MISMATCH" });
    const [row] = await ownerSql<Array<{ migration_table: string | null }>>`
      SELECT pg_catalog.to_regclass('accounts.schema_migrations')::text AS migration_table
    `;
    expect(row?.migration_table).toBeNull();
  });

  test("supports a separately provisioned direct LOGIN runtime boundary", async () => {
    const directBoundary = { mode: "direct", roleName: directRole } as const;
    const report = await runPostgresMigrations(
      ownerSql as unknown as PostgresSqlClient,
      { runtimeRole: directBoundary },
    );
    expect(report.runtimeRoleMode).toBe("direct");
    const context = await directSql.begin("read only", async (transaction) => {
      await installPostgresRuntimeContext(transaction, {
        principalRef: ownerB,
        role: directBoundary,
      });
      const [row] = await transaction<Array<{
        current_user: string;
        session_user: string;
      }>>`SELECT current_user, session_user`;
      return row;
    });
    expect(context).toEqual({ current_user: directRole, session_user: directRole });
  });
});
