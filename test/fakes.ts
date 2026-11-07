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
export const scriptedModel = (steps: Step[]) => {
  const requests: Message[][] = []
  const layer = Layer.succeed(
    ModelClient,
    ModelClient.of({
      chat: (history) =>
        Stream.suspend(() => {
          requests.push([...history])
          const next = steps[requests.length - 1] ?? fail("The script has no reply left for this step")
          return Stream.fromIterable(next).pipe(
            Stream.mapEffect((item) => (item instanceof ProviderError ? Effect.fail(item) : Effect.succeed(item))),
          )
        }),
    }),
  )
  return { layer, requests }
}

// A terminal where the user types the given answers, in order. When they run out, input ends.
// `output` holds the finished lines; `writes` holds every piece passed to `write`, in order.
export const scriptedTerminal = (answers: string[]) => {
  const output: string[] = []
  const writes: string[] = []
  const queue = [...answers]
  let pending = "" // text written since the last line ended
  const layer = Layer.succeed(
    Terminal,
    Terminal.of({
      ask: (prompt) =>
        Effect.suspend(() => {
          output.push(pending + prompt)
          pending = ""
          const next = queue.shift()
          return next === undefined ? Effect.fail(new InputClosed()) : Effect.succeed(next)
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