import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { repl } from "../src/agent"
import { estimateTokens, isDue, SUMMARY_PROMPT, transcript } from "../src/compaction"
import { summaryMessage } from "../src/history"
import type { Message } from "../src/messages"
import { Session, SessionLive } from "../src/session"
import { defineTool, Tools } from "../src/tool"
import { callTool, fail, reply, scriptedModel, scriptedTerminal, type Step } from "./fakes"

const echo = defineTool({
  name: "echo",
  description: "Returns its text.",
  input: Schema.Struct({ text: Schema.String }),
  execute: async ({ text }) => text,
})

const textOfFirst = (request: Message[] | undefined) => {
  const part = request?.[0]?.content[0]
  return part?.type === "text" ? part.text : ""
}

// Runs one prompt on a session kept in memory, with a model whose window is `contextWindow` tokens.
const run = async (model: Step[], contextWindow: number) => {
  const scripted = scriptedModel(model, undefined, contextWindow)
  const terminal = scriptedTerminal(["read it"])
  const layers = Layer.mergeAll(scripted.layer, terminal.layer, Layer.succeed(Tools, [echo]), SessionLive({ path: ":memory:", id: "test" }))
  const events = await Effect.runPromise(
    Effect.gen(function* () {
      yield* repl
      return yield* (yield* Session).events
    }).pipe(Effect.provide(layers)),
  )
  return { events, requests: scripted.requests, output: terminal.output }
}

// 4,000 characters are about 1,000 tokens, once as the call's input and once as its result.
const long = "x".repeat(4_000)

describe("the estimate", () => {
  test("counts about one token per four characters of history and tools", () => {
    const history: Message[] = [{ role: "user", content: [{ type: "text", text: long }] }]

    expect(estimateTokens(history, [])).toBe(Math.ceil(JSON.stringify([history, []]).length / 4))
    expect(estimateTokens(history, [echo])).toBeGreaterThan(estimateTokens(history, []))
  })

  test("is due from three quarters of the window", () => {
    expect(isDue(749, 1_000)).toBe(false)
    expect(isDue(750, 1_000)).toBe(true)
  })

  test("the transcript clips long tool inputs and results", () => {
    const text = transcript([
      { role: "assistant", content: [{ type: "tool-call", id: "a", name: "echo", input: { text: long } }] },
      { role: "tool", content: [{ type: "tool-result", id: "a", name: "echo", result: { type: "text", value: long } }] },
    ])

    expect(text).toContain("[... 2000 more characters]")
    expect(text.length).toBeLessThan(5_000)
  })
})

describe("compaction", () => {
  test("summarizes the history when the next request comes close to the window", async () => {
    const { events, requests, output } = await run(
      [callTool("call_1", "echo", { text: long }), reply("The user asked to read it."), reply("Done.")],
      1_000,
    )

    expect(events.map((event) => event.type)).toEqual(["prompt", "step-finished", "tool-result", "compacted", "step-finished"])
    // The second request is the summary request: the conversation as text, then the instructions.
    expect(requests[1]).toHaveLength(1)
    expect(textOfFirst(requests[1])).toStartWith("<conversation>\nUser:\nread it")
    expect(textOfFirst(requests[1])).toEndWith(SUMMARY_PROMPT)
    // The step after it starts from the summary alone.
    expect(requests[2]).toEqual([summaryMessage("The user asked to read it.")])
    expect(output.some((line) => /^\[compacting: ~\d+ tokens\]$/.test(line))).toBe(true)
    expect(output.some((line) => /^\[compacted: \d+ → \d+ tokens\]$/.test(line))).toBe(true)
  })

  test("leaves a history that fits alone", async () => {
    const { events, requests } = await run([callTool("call_1", "echo", { text: long }), reply("Done.")], 100_000)

    expect(events.map((event) => event.type)).toEqual(["prompt", "step-finished", "tool-result", "step-finished"])
    expect(requests).toHaveLength(2)
  })

  test("a summary that fails fails the turn, and nothing is compacted", async () => {
    const { events, output } = await run([callTool("call_1", "echo", { text: long }), fail("connection reset")], 1_000)

    expect(events.map((event) => event.type)).toEqual(["prompt", "step-finished", "tool-result", "turn-failed"])
    expect(output).toContain("[provider error] connection reset")
  })

  test("an empty summary fails the turn too", async () => {
    const { events, output } = await run([callTool("call_1", "echo", { text: long }), reply("  ")], 1_000)

    expect(events.at(-1)).toEqual({ type: "turn-failed", reason: "The model returned an empty summary" })
    expect(output).toContain("[provider error] The model returned an empty summary")
  })
})