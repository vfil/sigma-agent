import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { anthropicMessages, openaiChat, type Protocol } from "../src/protocols"
import { frames } from "../src/sse"

// The last message of a stream ends with a blank line. A fixture copied from a web page can lose it, so it is added back.
const fixture = async (name: string) => {
  const text = await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text()
  return new TextEncoder().encode(text.trimEnd() + "\n\n")
}

// Cuts bytes into pieces at the given positions.
const cutAt = (bytes: Uint8Array, positions: number[]) =>
  [0, ...positions].map((start, i) => bytes.slice(start, positions[i] ?? bytes.length))

// Runs recorded bytes through the framing and a protocol.
const decode = (protocol: Protocol, bytes: Uint8Array, positions: number[] = []) =>
  Effect.runPromise(protocol.events(frames(Stream.fromIterable(cutAt(bytes, positions)))).pipe(Stream.runCollect))

describe("OpenAI chat protocol", () => {
  test("Ollama streams text a piece at a time", async () => {
    const events = await decode(openaiChat, await fixture("ollama-text.sse"))

    expect(events.map((event) => (event.type === "text-delta" ? event.text : event.type))).toEqual([
      "Hello", ",", " nice", " to", " meet", " you", ".", "finish",
    ])
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" })
  })

  test("llama.cpp skips the empty first chunk and ends with a finish", async () => {
    const events = await decode(openaiChat, await fixture("llamacpp-text.sse"))

    expect(events.map((event) => (event.type === "text-delta" ? event.text : event.type)).join("")).toBe("Hello from an AI assistant.finish")
  })

  test("llama.cpp sends a tool call in fragments, and one tool-call event comes out", async () => {
    const events = await decode(openaiChat, await fixture("llamacpp-tool.sse"))

    expect(events).toEqual([
      { type: "tool-call", id: "lweYCONr7qLC7dbqrULRsZcuyviVrCTP", name: "read_file", input: { path: "notes/todo.txt" } },
      { type: "finish", reason: "tool-calls" },
    ])
  })

  test("Ollama sends a tool call whole, and the events have the same shape", async () => {
    const events = await decode(openaiChat, await fixture("ollama-tool.sse"))

    expect(events).toEqual([
      { type: "tool-call", id: "call_erxo8g8t", name: "read_file", input: { path: "notes/todo.txt" } },
      { type: "finish", reason: "tool-calls" },
    ])
  })
})

describe("Anthropic Messages protocol", () => {
  test("streams text, assembles tool calls, and keeps every block for replay", async () => {
    const events = await decode(anthropicMessages, await fixture("claude-tool.sse"))

    expect(events).toEqual([
      { type: "text-delta", text: "I'll read" },
      { type: "text-delta", text: " the file." },
      { type: "tool-call", id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6", name: "read_file", input: { path: "notes/todo.txt" } },
      { type: "tool-call", id: "toolu_01B2x2gK45rBnl3uOsO8Vq7", name: "list_files", input: {} },
      {
        type: "finish",
        reason: "tool-calls",
        native: [
          { type: "thinking", thinking: "The user wants the notes.", signature: "EqQBCgIYAhIM" },
          { type: "text", text: "I'll read the file." },
          { type: "tool_use", id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6", name: "read_file", input: { path: "notes/todo.txt" } },
          { type: "tool_use", id: "toolu_01B2x2gK45rBnl3uOsO8Vq7", name: "list_files", input: {} },
        ],
      },
    ])
  })
})

describe("framing", () => {
  test("the events do not depend on where the bytes are cut", async () => {
    for (const [protocol, name] of [
      [openaiChat, "llamacpp-tool.sse"],
      [anthropicMessages, "claude-tool.sse"],
    ] as const) {
      const bytes = await fixture(name)
      const whole = await decode(protocol, bytes)
      for (let at = 1; at < bytes.length; at++) {
        expect(await decode(protocol, bytes, [at])).toEqual(whole)
      }
    }
  })

  test("a character can be split between two pieces", async () => {
    const bytes = new TextEncoder().encode("data: héllo\n\n")
    const at = bytes.indexOf(0xc3) + 1 // between the two bytes of é

    const result = await Effect.runPromise(Stream.runCollect(frames(Stream.fromIterable(cutAt(bytes, [at])))))

    expect(result).toEqual([{ event: undefined, data: "héllo" }])
  })

  test("data lines join with a newline, and comments and unknown fields are ignored", async () => {
    const bytes = new TextEncoder().encode(": keep-alive\nevent: note\nid: 7\ndata: one\ndata: two\n\n")

    const result = await Effect.runPromise(Stream.runCollect(frames(Stream.fromIterable([bytes]))))

    expect(result).toEqual([{ event: "note", data: "one\ntwo" }])
  })
})