import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { makeLines } from "../src/lines"
import { InputClosed } from "../src/errors"

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test("keeps lines that arrive before anyone asks, in order", async () => {
  const lines = makeLines()
  lines.push("one")
  lines.push("two")
  expect(await Effect.runPromise(lines.next)).toBe("one")
  expect(await Effect.runPromise(lines.next)).toBe("two")
})

test("gives a line to the question that is waiting", async () => {
  const lines = makeLines()
  const answer = Effect.runPromise(lines.next)
  lines.push("hello")
  expect(await answer).toBe("hello")
})

test("gives the line to the newest of several open questions", async () => {
  const lines = makeLines()
  const reader = Effect.runPromise(lines.next) // "You: "
  const confirm = Effect.runPromise(lines.next) // "Allow? [y/N]"
  lines.push("y")
  expect(await confirm).toBe("y")
  lines.push("next prompt")
  expect(await reader).toBe("next prompt")
})

test("fails the open questions when input ends, after the waiting lines are used", async () => {
  const lines = makeLines()
  lines.push("last")
  lines.end()
  expect(await Effect.runPromise(lines.next)).toBe("last")
  expect(await Effect.runPromise(Effect.flip(lines.next))).toBeInstanceOf(InputClosed)

  const open = makeLines()
  const pending = Effect.runPromise(Effect.flip(open.next))
  open.end()
  expect(await pending).toBeInstanceOf(InputClosed)
})

test("an interrupted question does not take the next line", async () => {
  const lines = makeLines()
  const first = Effect.runFork(lines.next)
  await settle()
  await Effect.runPromise(Fiber.interrupt(first))
  const second = Effect.runPromise(lines.next)
  lines.push("for the second")
  expect(await second).toBe("for the second")
})