import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repl } from "../src/agent"
import type { SessionEvent } from "../src/session-event"
import { Session, SessionLive } from "../src/session"
import { defineTool, Tools } from "../src/tool"
import { callTool, reply, scriptedModel, scriptedTerminal } from "./fakes"

// A crash leaves the log as it was at the moment the process died. These tests write that log with
// `append`, close the file, and start the agent again on it.
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-session-"))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const ran: string[] = []
const echo = defineTool({
  name: "echo",
  description: "Returns its text.",
  input: Schema.Struct({ text: Schema.String }),
  execute: async ({ text }) => (ran.push(text), text),
})

const prompt = (text: string): SessionEvent => ({ type: "prompt", text })
const calls = (...ids: string[]): SessionEvent => ({
  type: "step-finished",
  message: { role: "assistant", content: ids.map((id) => ({ type: "tool-call", id, name: "echo", input: { text: id } })) },
  finish: "tool-calls",
})
const result = (id: string): SessionEvent => ({
  type: "tool-result",
  part: { type: "tool-result", id, name: "echo", result: { type: "text", value: id } },
})

// Process one: the events that were written before the crash.
const crashAfter = (events: SessionEvent[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session
      for (const event of events) yield* session.append(event)
    }).pipe(Effect.provide(SessionLive({ path: join(dir, "agent.db"), id: "s" }))),
  )

// Process two: a new agent on the same file. No input, so it only finishes what it finds.
const restart = async (modelSteps: Parameters<typeof scriptedModel>[0]) => {
  const model = scriptedModel(modelSteps)
  const terminal = scriptedTerminal([])
  const layers = Layer.mergeAll(model.layer, terminal.layer, Layer.succeed(Tools, [echo]), SessionLive({ path: join(dir, "agent.db"), id: "s" }))
  const events = await Effect.runPromise(
    Effect.gen(function* () {
      yield* repl
      return yield* (yield* Session).events
    }).pipe(Effect.provide(layers)),
  )
  return { events, requests: model.requests, output: terminal.output }
}

describe("resuming a session", () => {
  test("answers a call that has no result with an error and never runs it again", async () => {
    ran.length = 0
    await crashAfter([prompt("go"), calls("a", "b"), result("a")])

    const { events, requests, output } = await restart([reply("Understood.")])

    expect(output[0]).toBe("[resuming session s]")
    expect(ran).toEqual([])
    const tool = requests[0]?.at(-1)
    expect(tool?.role).toBe("tool")
    expect(tool?.content.map((part) => (part.type === "tool-result" ? [part.id, part.result.type] : []))).toEqual([
      ["a", "text"],
      ["b", "error"],
    ])
    expect(JSON.stringify(tool)).toContain("stopped before this tool finished")
    expect(events.map((event) => event.type)).toEqual(["prompt", "step-finished", "tool-result", "tool-result", "step-finished"])
  })

  test("continues a turn that stopped right after the prompt", async () => {
    await crashAfter([prompt("hello")])

    const { requests, output } = await restart([reply("Hi.")])

    expect(output).toContain("Agent: Hi.")
    expect(requests[0]?.map((message) => message.role)).toEqual(["user"])
  })

  test("continues a turn that stopped between the last result and the next step", async () => {
    await crashAfter([prompt("go"), calls("a"), result("a")])

    const { requests } = await restart([reply("Done.")])

    expect(requests[0]?.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
  })

  test("leaves a finished turn alone", async () => {
    await crashAfter([prompt("hi"), { type: "step-finished", message: { role: "assistant", content: [{ type: "text", text: "Hello." }] }, finish: "stop" }])

    const { requests, output } = await restart([])

    expect(requests).toEqual([])
    expect(output.join("\n")).not.toContain("resuming")
  })

  test("leaves a failed turn alone", async () => {
    await crashAfter([prompt("hi"), { type: "turn-failed", reason: "connection reset" }])

    const { requests, output } = await restart([])

    expect(requests).toEqual([])
    expect(output.join("\n")).not.toContain("resuming")
  })

  test("a resumed turn that calls a tool runs it like any other", async () => {
    ran.length = 0
    await crashAfter([prompt("go")])

    await restart([callTool("c9", "echo", { text: "again" }), reply("Done.")])

    expect(ran).toEqual(["again"])
  })
})