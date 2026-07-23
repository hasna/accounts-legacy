import { describe, expect, test } from "bun:test";

import { POSTGRES_FINAL_TABLES } from "./postgres-migrations.js";
import { POSTGRES_SCHEMA_MANIFEST } from "./postgres-schema-manifest.js";

describe("Postgres schema manifest", () => {
  test("covers every final table, column, and primary key exactly once", () => {
    const manifestTables = [
      ...new Set(POSTGRES_SCHEMA_MANIFEST.columns.map((entry) => entry[0])),
    ].sort();
    expect(manifestTables).toEqual([...POSTGRES_FINAL_TABLES].sort());

    const columnKeys = POSTGRES_SCHEMA_MANIFEST.columns.map(
      (entry) => `${entry[0]}.${entry[1]}.${entry[2]}`,
    );
    expect(new Set(columnKeys).size).toBe(columnKeys.length);

    const primaryKeyTables = POSTGRES_SCHEMA_MANIFEST.constraints
      .filter((entry) => entry[2] === "p")
      .map((entry) => entry[0])
      .sort();
    expect(primaryKeyTables).toEqual(manifestTables);
  });

  test("pins collation, ordered CAS keys, maintenance FK action, and partial-index predicates", () => {
    expect(POSTGRES_SCHEMA_MANIFEST.columns).toContainEqual([
      "schema_migrations",
      4,
      "ledger_sequence",
      "bigint",
      true,
      null,
      "a",
      "",
      null,
    ]);
    expect(POSTGRES_SCHEMA_MANIFEST.columns).toContainEqual([
      "capability_use_consumptions",
      6,
      "receipt_jcs_base64url",
      "text",
      true,
      null,
      "",
      "",
      "pg_catalog.default",
    ]);
    expect(POSTGRES_SCHEMA_MANIFEST.constraints).toContainEqual([
      "capability_use_consumptions",
      "capability_use_consumptions_owner_ref_capability_id_key",
      "u",
      "UNIQUE (owner_ref, capability_id)",
      false,
      false,
      true,
    ]);
    expect(POSTGRES_SCHEMA_MANIFEST.constraints).toContainEqual([
      "capsule_maintenance_uses",
      "capsule_maintenance_uses_grant_id_owner_ref_fkey",
      "f",
      "FOREIGN KEY (grant_id, owner_ref) REFERENCES accounts.capsule_maintenance_grants(grant_id, owner_ref) ON DELETE RESTRICT",
      false,
      false,
      true,
    ]);
    expect(POSTGRES_SCHEMA_MANIFEST.indexes).toContainEqual([
      "capsule_maintenance_grants",
      "capsule_maintenance_one_live_reservation",
      "btree",
      true,
      true,
      true,
      true,
      "CREATE UNIQUE INDEX capsule_maintenance_one_live_reservation ON accounts.capsule_maintenance_grants USING btree (owner_ref, reservation_key_digest) WHERE state = 'live'::text",
      "state = 'live'::text",
    ]);
  });

  test("is deeply frozen at the exported boundary", () => {
    expect(Object.isFrozen(POSTGRES_SCHEMA_MANIFEST)).toBe(true);
    expect(Object.isFrozen(POSTGRES_SCHEMA_MANIFEST.columns)).toBe(true);
    expect(Object.isFrozen(POSTGRES_SCHEMA_MANIFEST.columns[0])).toBe(true);
    expect(Object.isFrozen(POSTGRES_SCHEMA_MANIFEST.constraints)).toBe(true);
    expect(Object.isFrozen(POSTGRES_SCHEMA_MANIFEST.indexes)).toBe(true);
  });
});
