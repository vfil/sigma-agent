import { describe, expect, test } from "bun:test"
import { summaryMessage, toHistory, unansweredCalls } from "../src/history"
import type { ToolResultPart } from "../src/messages"
import type { SessionEvent } from "../src/session-event"

const prompt = (text: string): SessionEvent => ({ type: "prompt", text })
const answer = (text: string): SessionEvent => ({
  type: "step-finished",
  message: { role: "assistant", content: [{ type: "text", text }] },
  finish: "stop",
})
const calls = (...ids: string[]): SessionEvent => ({
  type: "step-finished",
  message: { role: "assistant", content: ids.map((id) => ({ type: "tool-call", id, name: "echo", input: {} })) },
  finish: "tool-calls",
})
const result = (id: string): SessionEvent => {
  const part: ToolResultPart = { type: "tool-result", id, name: "echo", result: { type: "text", value: id } }
  return { type: "tool-result", part }
}
const failed: SessionEvent = { type: "turn-failed", reason: "connection reset" }
const compacted = (summary: string): SessionEvent => ({ type: "compacted", summary })

describe("toHistory", () => {
  test("turns events into messages in order", () => {
    const history = toHistory([prompt("hi"), answer("hello")])

    expect(history.map((message) => message.role)).toEqual(["user", "assistant"])
  })

  test("puts results that follow one another in one tool message", () => {
    const history = toHistory([prompt("go"), calls("a", "b"), result("a"), result("b")])

    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(history[2]?.content).toHaveLength(2)
  })

  test("leaves out a failed turn and keeps the turns before it", () => {
    const history = toHistory([prompt("one"), answer("first"), prompt("two"), calls("a"), failed, prompt("three")])

    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "user"])
  })
})

describe("toHistory after a compaction", () => {
  test("starts from the latest summary and keeps what came after it", () => {
    const history = toHistory([prompt("one"), answer("first"), prompt("two"), calls("a"), result("a"), compacted("S1"), answer("second")])

    expect(history).toEqual([summaryMessage("S1"), { role: "assistant", content: [{ type: "text", text: "second" }] }])
  })

  test("a later summary replaces an earlier one", () => {
    const history = toHistory([prompt("one"), compacted("S1"), answer("first"), prompt("two"), compacted("S2")])

    expect(history).toEqual([summaryMessage("S2")])
  })

  test("a turn that fails after a summary is cut back to the summary", () => {
    const history = toHistory([prompt("go"), calls("a"), result("a"), compacted("S1"), calls("b"), result("b"), failed])

    expect(history).toEqual([summaryMessage("S1")])
  })

  test("a turn that starts after a summary is cut back to its own prompt", () => {
    const history = toHistory([prompt("one"), compacted("S1"), answer("first"), prompt("two"), calls("a"), failed])

    expect(history.map((message) => message.role)).toEqual(["user", "assistant"])
  })
})

describe("unansweredCalls", () => {
  test("is undefined when the last turn finished", () => {
    expect(unansweredCalls(toHistory([prompt("hi"), answer("hello")]))).toBeUndefined()
    expect(unansweredCalls(toHistory([prompt("hi"), failed]))).toBeUndefined()
    expect(unansweredCalls([])).toBeUndefined()
  })

  test("is empty when the model has to answer next", () => {
    expect(unansweredCalls(toHistory([prompt("hi")]))).toEqual([])
    expect(unansweredCalls(toHistory([prompt("hi"), calls("a"), result("a")]))).toEqual([])
  })

  test("lists the calls that have no result", () => {
    expect(unansweredCalls(toHistory([prompt("go"), calls("a", "b")]))?.map((call) => call.id)).toEqual(["a", "b"])
    expect(unansweredCalls(toHistory([prompt("go"), calls("a", "b"), result("a")]))?.map((call) => call.id)).toEqual(["b"])
  })
})