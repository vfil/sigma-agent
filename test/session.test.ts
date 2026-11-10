import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionCorrupt } from "../src/errors"
import { Session, SessionLive } from "../src/session"

let path: string
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-session-"))
  path = join(dir, "agent.db")
})
afterEach(() => rm(dir, { recursive: true, force: true }))

// Opens the file, runs `use`, and closes the file again, like one run of the agent.
const using = <A, E>(id: string, use: (session: Session["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.gen(function* () { return yield* use(yield* Session) }).pipe(Effect.provide(SessionLive({ path, id }))))

test("reads back what was appended, in order, after the file is closed and opened again", async () => {
  await using("s", (session) => session.append({ type: "prompt", text: "one" }).pipe(Effect.andThen(session.append({ type: "prompt", text: "two" }))))

  const events = await using("s", (session) => session.events)

  expect(events).toEqual([
    { type: "prompt", text: "one" },
    { type: "prompt", text: "two" },
  ])
})

test("keeps the events of two sessions apart", async () => {
  await using("a", (session) => session.append({ type: "prompt", text: "for a" }))
  await using("b", (session) => session.append({ type: "prompt", text: "for b" }))

  expect(await using("b", (session) => session.events)).toEqual([{ type: "prompt", text: "for b" }])
})

test("names the event that does not match the schema", async () => {
  await using("s", (session) => session.append({ type: "prompt", text: "hi" }))
  const db = new Database(path)
  db.run(`insert into event (session_id, seq, type, data) values ('s', 2, 'prompt', '{"type":"prompt"}')`)
  db.close()

  const error = await using("s", (session) => Effect.flip(session.events))

  expect(error).toBeInstanceOf(SessionCorrupt)
  expect(error).toMatchObject({ session: "s", seq: 2 })
})