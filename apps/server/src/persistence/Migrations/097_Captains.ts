import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS captains (
      captain_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      charter TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT '',
      plan_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_captains_project ON captains(project_id, created_at, captain_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS captain_needs (
      need_id TEXT PRIMARY KEY,
      captain_id TEXT NOT NULL REFERENCES captains(captain_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL,
      resolution TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_captain_needs_captain
      ON captain_needs(captain_id, status, created_at)
  `;
});
