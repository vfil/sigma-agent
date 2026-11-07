import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { ModelEvent } from "../src/events"
import { openaiChat } from "../src/protocols"
import { chat, type Route } from "../src/provider"

const sse = (...lines: string[]) => lines.map((line) => `${line}\n\n`).join("")

const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}`

// Serves one canned answer, runs one step against it, and reports what arrived and how the step ended:
// the error message, or an empty string when the step finished.
const step = async (respond: (request: Request) => Response | Promise<Response>, baseUrl?: string) => {
  const server = Bun.serve({ port: 0, fetch: respond })
  const route: Route = { protocol: openaiChat, baseUrl: baseUrl ?? `http://127.0.0.1:${server.port}`, headers: {}, model: "test" }
  const events: ModelEvent[] = []
  try {
    const failure = await Effect.runPromise(
      Stream.runForEach(chat(route, [], []), (event) => Effect.sync(() => void events.push(event))).pipe(
        Effect.as(""),
        Effect.catchTag("ProviderError", (error) => Effect.succeed(error.message)),
      ),
    )
    return { events, failure }
  } finally {
    await server.stop(true)
  }
}

describe("one step over HTTP", () => {
  test("asks for a stream and delivers the events", async () => {
    let sent: { stream?: boolean } = {}
    const { events, failure } = await step(async (request) => {
      sent = (await request.json()) as { stream?: boolean }
      return new Response(sse(chunk({ content: "Hi" }), chunk({ content: "!" }), chunk({}, "stop"), "data: [DONE]"))
    })

    expect(failure).toBe("")
    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "text-delta", text: "!" },
      { type: "finish", reason: "stop" },
    ])
    expect(sent.stream).toBe(true)
  })

  test("fails when the stream ends before the model finishes, after delivering what arrived", async () => {
    const { events, failure } = await step(() => new Response(sse(chunk({ content: "The answer" }), chunk({ content: " is" }))))

    expect(events).toEqual([
      { type: "text-delta", text: "The answer" },
      { type: "text-delta", text: " is" },
    ])
    expect(failure).toContain("ended before the model finished")
  })

  test("fails on a frame that is not JSON", async () => {
    const { failure } = await step(() => new Response(sse(chunk({ content: "ok" }), "data: {oops")))

    expect(failure).toContain("Could not read the stream")
  })

  test("reports the server's answer when the status is an error", async () => {
    const { events, failure } = await step(() => new Response("model not found", { status: 404 }))

    expect(events).toEqual([])
    expect(failure).toContain("answered 404: model not found")
  })

  test("reports a server that is not running", async () => {
    const { failure } = await step(() => new Response(""), "http://127.0.0.1:1")

    expect(failure).toContain("Could not reach")
  })
})