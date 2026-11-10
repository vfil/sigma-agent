import { SqliteClient } from "@effect/sql-sqlite-bun"
import { asc, eq, max } from "drizzle-orm"
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun"
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionCorrupt } from "./errors"
import { toHistory } from "./history"
import type { Message } from "./messages"
import { SessionEvent } from "./session-event"
import { EventTable } from "./session-table"

// What the agent needs from its session: append a fact, and read the facts back.
export class Session extends Context.Service<
  Session,
  {
    readonly id: string
    readonly append: (event: SessionEvent) => Effect.Effect<void>
    // Every call reads the log again.
    readonly events: Effect.Effect<SessionEvent[], SessionCorrupt>
    readonly history: Effect.Effect<Message[], SessionCorrupt>
  }
>()("@agent/Session") {}

const migrationsFolder = new URL("../drizzle", import.meta.url).pathname
const decode = Schema.decodeUnknownEffect(SessionEvent)
const encode = Schema.encodeSync(SessionEvent)

// The real session: a SQLite file. Building the layer opens the file and applies the migrations;
// the end of the program closes it. A disk failure is a defect, not something the agent can handle.
export const SessionLive = (options: { path: string; id: string }) =>
  Layer.effect(
    Session,
    Effect.gen(function* () {
      const db = yield* SQLiteBunDrizzle.makeWithDefaults()
      yield* migrate(db, { migrationsFolder })

      const thisSession = eq(EventTable.session_id, options.id)

      // The numbering continues where the log stops. One process writes a session, so it can count for itself.
      const [last] = yield* db.select({ seq: max(EventTable.seq) }).from(EventTable).where(thisSession)
      let seq = last?.seq ?? 0

      // A row that no longer matches the schema stops the read and says which event it was.
      const readEvent = (row: typeof EventTable.$inferSelect) =>
        decode(row.data).pipe(
          Effect.mapError((error) => new SessionCorrupt({ session: options.id, seq: row.seq, problem: error.message })),
        )

      const events = db.select().from(EventTable).where(thisSession).orderBy(asc(EventTable.seq)).pipe(
        Effect.flatMap(Effect.forEach(readEvent)),
        Effect.catchTag("EffectDrizzleQueryError", Effect.die),
      )

      const append = (event: SessionEvent) =>
        Effect.suspend(() =>
          db.insert(EventTable).values({ session_id: options.id, seq: ++seq, type: event.type, data: encode(event) }),
        ).pipe(Effect.asVoid, Effect.orDie)

      return Session.of({ id: options.id, append, events, history: Effect.map(events, toHistory) })
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(SqliteClient.layer({ filename: options.path }).pipe(Layer.orDie)))