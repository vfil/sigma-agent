import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// The event log: one row per session event. `seq` orders the events of a session.
export const EventTable = sqliteTable(
  "event",
  {
    session_id: text().notNull(),
    seq: integer().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.seq] })],
)