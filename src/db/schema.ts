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

// The inbox: the prompts a session has accepted and not yet run. A row is deleted when its prompt is delivered.
// `id` counts up, so the lowest id is the oldest prompt.
export const InboxTable = sqliteTable("inbox", {
  id: integer().primaryKey({ autoIncrement: true }),
  session_id: text().notNull(),
  text: text().notNull(),
})