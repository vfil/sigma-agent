import { SqliteClient } from "@effect/sql-sqlite-bun"
import { asc, count, eq, max } from "drizzle-orm"
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun"
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionCorrupt } from "./errors"
import { toHistory } from "./history"
import type { Message } from "./messages"
import { SessionEvent } from "./session-event"
import { EventTable, InboxTable } from "./db/schema"

// What the agent needs from its session: accept prompts, append facts, and read the facts back.
export class Session extends Context.Service<
  Session,
  {
    readonly id: string
    // Saves a prompt in the inbox. From this moment it survives a restart, whether or not the model ever sees it.
    readonly admit: (text: string) => Effect.Effect<void>
    // Moves the oldest prompt out of the inbox and into the log as a `prompt` event, in one indivisible act.
    // Returns its text, or undefined when the inbox is empty.
    readonly deliver: Effect.Effect<string | undefined>
    // How many prompts wait in the inbox.
    readonly pending: Effect.Effect<number>
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
      const thisInbox = eq(InboxTable.session_id, options.id)

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

      const admit = (text: string) =>
        db.insert(InboxTable).values({ session_id: options.id, text }).pipe(Effect.asVoid, Effect.orDie)

      // Deleting the inbox row and inserting the `prompt` event happen in one transaction: both take effect,
      // or neither does. A crash between the two statements cannot lose the prompt or deliver it twice.
      const deliver = Effect.suspend(() => {
        const next = seq + 1
        return db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [oldest] = yield* tx.select().from(InboxTable).where(thisInbox).orderBy(asc(InboxTable.id)).limit(1)
              if (!oldest) return undefined
              yield* tx.delete(InboxTable).where(eq(InboxTable.id, oldest.id))
              yield* tx
                .insert(EventTable)
                .values({ session_id: options.id, seq: next, type: "prompt", data: encode({ type: "prompt", text: oldest.text }) })
              return oldest.text
            }),
          )
          .pipe(
            // The number is used up only once the transaction has committed.
            Effect.tap((text) =>
              Effect.sync(() => {
                if (text !== undefined) seq = next
              }),
            ),
            Effect.orDie,
          )
      })

      const pending = db.select({ waiting: count() }).from(InboxTable).where(thisInbox).pipe(
        Effect.map(([row]) => row?.waiting ?? 0),
        Effect.orDie,
      )

      return Session.of({ id: options.id, admit, deliver, pending, append, events, history: Effect.map(events, toHistory) })
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(SqliteClient.layer({ filename: options.path }).pipe(Layer.orDie)))