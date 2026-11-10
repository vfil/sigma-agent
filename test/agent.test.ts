import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { repl } from "../src/agent"
import { ProviderError } from "../src/errors"
import { Session, SessionLive } from "../src/session"
import { defineTool, Tools } from "../src/tool"
import { callTool, fail, reply, scriptedModel, scriptedTerminal, type Step } from "./fakes"

// Two small tools, so the tests never touch the disk.
const echo = defineTool({
  name: "echo",
  description: "Returns its text.",
  input: Schema.Struct({ text: Schema.String }),
  execute: async ({ text }) => text,
})

const deleteEverything = defineTool({
  name: "delete_everything",
  description: "Pretends to delete everything.",
  input: Schema.Struct({}),
  execute: async () => "deleted",
  confirm: () => "delete everything",
})

// Runs the loop against a script, on a session kept in memory, and returns what the loop and the fakes saw.
const run = async (script: { model: Step[]; answers: string[] }) => {
  const model = scriptedModel(script.model)
  const terminal = scriptedTerminal(script.answers)
  const layers = Layer.mergeAll(model.layer, terminal.layer, Layer.succeed(Tools, [echo, deleteEverything]), SessionLive({ path: ":memory:", id: "test" }))

  const { history, events } = await Effect.runPromise(
    Effect.gen(function* () {
      yield* repl
      const session = yield* Session
      return { history: yield* session.history, events: yield* session.events }
    }).pipe(Effect.provide(layers)),
  )
  return { history, events, requests: model.requests, output: terminal.output, writes: terminal.writes }
}

describe("the agent loop", () => {
  test("runs a tool call and then answers", async () => {
    const { history, output } = await run({
      model: [callTool("call_1", "echo", { text: "hi" }), reply("The tool said hi.")],
      answers: ["say hi"],
    })

    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(history[2]?.content).toEqual([{ type: "tool-result", id: "call_1", name: "echo", result: { type: "text", value: "hi" } }])
    expect(output).toContain("Agent: The tool said hi.")
  })

  test("tells the model when the user declines", async () => {
    const { requests } = await run({
      model: [callTool("call_1", "delete_everything", {}), reply("Understood, I will not delete anything.")],
      answers: ["clean up", "n"],
    })

    // The second request is the step after the tool call: its last message holds the result.
    const result = requests[1]?.at(-1)?.content[0]
    expect(result).toMatchObject({ type: "tool-result", result: { type: "error" } })
    expect(JSON.stringify(result)).toContain("User declined")
  })

  test("drops a turn whose model call fails", async () => {
    const { history, output } = await run({
      model: [fail("connection refused")],
      answers: ["hello"],
    })

    expect(history).toEqual([])
    expect(output).toContain("[provider error] connection refused")
  })

  test("shows the reply piece by piece", async () => {
    const { writes } = await run({ model: [reply("Hello there, friend.")], answers: ["hi"] })

    expect(writes).toEqual(["Agent: ", "Hello ", "there, ", "friend."])
  })

  test("ends the line of a reply that breaks off, then drops the turn", async () => {
    const { history, events, output } = await run({
      model: [[{ type: "text-delta", text: "The answer is" }, new ProviderError({ reason: "connection reset" })]],
      answers: ["hello"],
    })

    expect(history).toEqual([])
    expect(events.map((event) => event.type)).toEqual(["prompt", "turn-failed"])
    expect(output).toContain("Agent: The answer is")
    expect(output).toContain("[provider error] connection reset")
  })

  test("appends each fact to the log as it happens", async () => {
    const { events } = await run({
      model: [callTool("call_1", "echo", { text: "hi" }), reply("The tool said hi.")],
      answers: ["say hi"],
    })

    expect(events.map((event) => event.type)).toEqual(["prompt", "step-finished", "tool-result", "step-finished"])
  })
})