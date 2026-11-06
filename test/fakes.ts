import { Effect, Layer } from "effect"
import { InputClosed, ProviderError } from "../src/errors"
import type { Message } from "../src/messages"
import { ModelClient } from "../src/model-client"
import type { Reply } from "../src/protocols"
import { Terminal } from "../src/terminal"

// Replies the scripted model gives, in order. A ProviderError makes that step fail instead.
export type Step = Reply | ProviderError

export const reply = (text: string): Step => ({ message: { role: "assistant", content: [{ type: "text", text }] }, finish: "stop" })

export const callTool = (id: string, name: string, input: unknown): Step => ({
  message: { role: "assistant", content: [{ type: "tool-call", id, name, input }] },
  finish: "tool-calls",
})

// A model that follows a script and records the history it was given at each step.
export const scriptedModel = (steps: Step[]) => {
  const requests: Message[][] = []
  const layer = Layer.succeed(
    ModelClient,
    ModelClient.of({
      chat: (history) =>
        Effect.suspend(() => {
          requests.push([...history])
          const next = steps[requests.length - 1]
          if (!next) return Effect.fail(new ProviderError({ reason: "The script has no reply left for this step" }))
          return next instanceof ProviderError ? Effect.fail(next) : Effect.succeed(next)
        }),
    }),
  )
  return { layer, requests }
}

// A terminal where the user types the given answers, in order. When they run out, input ends.
export const scriptedTerminal = (answers: string[]) => {
  const output: string[] = []
  const queue = [...answers]
  const layer = Layer.succeed(
    Terminal,
    Terminal.of({
      ask: (prompt) =>
        Effect.suspend(() => {
          output.push(prompt)
          const next = queue.shift()
          return next === undefined ? Effect.fail(new InputClosed()) : Effect.succeed(next)
        }),
      say: (line) => Effect.sync(() => void output.push(line)),
    }),
  )
  return { layer, output }
}