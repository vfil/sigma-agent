import { Effect, Layer, Stream } from "effect"
import { InputClosed, ProviderError } from "../src/errors"
import type { ModelEvent } from "../src/events"
import type { Message } from "../src/messages"
import { ModelClient } from "../src/model-client"
import { Terminal } from "../src/terminal"

// What the scripted model streams for one step, in order. A ProviderError makes the stream fail at that point.
export type Step = Array<ModelEvent | ProviderError>

// A text reply, streamed one word at a time.
export const reply = (text: string): Step => [
  ...text.split(/(?<= )/).map((word): ModelEvent => ({ type: "text-delta", text: word })),
  { type: "finish", reason: "stop" },
]

export const callTool = (id: string, name: string, input: unknown): Step => [
  { type: "tool-call", id, name, input },
  { type: "finish", reason: "tool-calls" },
]

// A step that fails before sending anything.
export const fail = (reason: string): Step => [new ProviderError({ reason })]

// A model that follows a script and records the history it was given at each step.
// `beforeStep` runs when a step starts and holds the stream back until its promise settles.
export const scriptedModel = (steps: Step[], beforeStep?: (request: number) => Promise<void>) => {
  const requests: Message[][] = []
  const layer = Layer.succeed(
    ModelClient,
    ModelClient.of({
      chat: (history) =>
        Stream.suspend(() => {
          requests.push([...history])
          const request = requests.length
          const next = steps[request - 1] ?? fail("The script has no reply left for this step")
          const events = Stream.fromIterable(next).pipe(
            Stream.mapEffect((item) => (item instanceof ProviderError ? Effect.fail(item) : Effect.succeed(item))),
          )
          return beforeStep ? Stream.unwrap(Effect.promise(() => beforeStep(request)).pipe(Effect.as(events))) : events
        }),
    }),
  )
  return { layer, requests }
}

// A terminal where the user types the given answers, in order. An answer can be a promise, for a line the user types later.
// When the answers run out, input ends.
// Questions that start with "Allow" are answered from `confirmations` instead, so a confirmation reaches the
// tool that asked even though the reader has already taken every prompt, as the live terminal does.
// `output` holds the finished lines; `writes` holds every piece passed to `write`, in order.
export const scriptedTerminal = (answers: Array<string | Promise<string>>, confirmations: string[] = []) => {
  const output: string[] = []
  const writes: string[] = []
  const queue = [...answers]
  const confirm = [...confirmations]
  let pending = "" // text written since the last line ended
  const layer = Layer.succeed(
    Terminal,
    Terminal.of({
      ask: (prompt) =>
        Effect.suspend(() => {
          output.push(pending + prompt)
          pending = ""
          const next = (prompt.startsWith("Allow") ? confirm : queue).shift()
          if (next === undefined) return Effect.fail(new InputClosed())
          return typeof next === "string" ? Effect.succeed(next) : Effect.promise(() => next)
        }),
      say: (line) =>
        Effect.sync(() => {
          output.push(pending + line)
          pending = ""
        }),
      write: (text) =>
        Effect.sync(() => {
          writes.push(text)
          pending += text
        }),
    }),
  )
  return { layer, output, writes }
}