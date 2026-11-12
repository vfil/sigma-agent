import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Session, SessionLive } from "../src/session"

let path: string
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-inbox-"))
  path = join(dir, "agent.db")
})
afterEach(() => rm(dir, { recursive: true, force: true }))

// Opens the file, runs `use`, and closes the file again, like one run of the agent.
const using = <A, E>(id: string, use: (session: Session["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.gen(function* () { return yield* use(yield* Session) }).pipe(Effect.provide(SessionLive({ path, id }))))

test("delivers the prompts in the order they were admitted, then reports an empty inbox", async () => {
  const delivered = await using("s", (session) =>
    Effect.gen(function* () {
      yield* session.admit("one")
      yield* session.admit("two")
      return [yield* session.deliver, yield* session.deliver, yield* session.deliver]
    }),
  )
  expect(delivered).toEqual(["one", "two", undefined])
})

test("moves a prompt from the inbox to the log", async () => {
  const { before, after, events } = await using("s", (session) =>
    Effect.gen(function* () {
      yield* session.admit("hello")
      const before = { pending: yield* session.pending, events: (yield* session.events).length }
      yield* session.deliver
      const after = { pending: yield* session.pending }
      return { before, after, events: yield* session.events }
    }),
  )
  expect(before).toEqual({ pending: 1, events: 0 })
  expect(after).toEqual({ pending: 0 })
  expect(events).toEqual([{ type: "prompt", text: "hello" }])
})

test("keeps an admitted prompt after the file is closed and opened again", async () => {
  await using("s", (session) => session.admit("still here"))
  expect(await using("s", (session) => session.pending)).toBe(1)
  expect(await using("s", (session) => session.deliver)).toBe("still here")
})

test("keeps the inboxes of two sessions apart", async () => {
  await using("a", (session) => session.admit("for a"))
  await using("b", (session) => session.admit("for b"))
  expect(await using("b", (session) => session.deliver)).toBe("for b")
  expect(await using("b", (session) => session.deliver)).toBeUndefined()
  expect(await using("a", (session) => session.pending)).toBe(1)
})

test("a delivery that fails leaves the prompt in the inbox", async () => {
  await using("s", (session) => session.admit("must not be lost"))

  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session
      // A second writer takes event number 1 after this session opened, so the insert in `deliver` is refused.
      const intruder = new Database(path)
      intruder.run(`insert into event (session_id, seq, type, data) values ('s', 1, 'prompt', '{"type":"prompt","text":"intruder"}')`)
      intruder.close()
      const exit = yield* Effect.exit(session.deliver)
      return { failed: Exit.isFailure(exit), pending: yield* session.pending }
    }).pipe(Effect.provide(SessionLive({ path, id: "s" }))),
  )

  expect(outcome).toEqual({ failed: true, pending: 1 })
})