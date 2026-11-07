import { Context, Effect, Layer } from "effect"
import { createInterface } from "node:readline/promises"
import { InputClosed } from "./errors"

// What the agent needs from the person at the keyboard. Nothing here says readline.
export class Terminal extends Context.Service<
  Terminal,
  {
    // Asks one question. The type says it can fail: input may have ended.
    readonly ask: (prompt: string) => Effect.Effect<string, InputClosed>
    readonly say: (line: string) => Effect.Effect<void>
    // Prints text without ending the line, so a reply can appear piece by piece.
    readonly write: (text: string) => Effect.Effect<void>
  }
>()("@agent/Terminal") {}

// The real terminal. Building the layer opens readline; the end of the program closes it.
export const TerminalLive = Layer.effect(
  Terminal,
  Effect.gen(function* () {
    const rl = yield* Effect.acquireRelease(
      Effect.sync(() => createInterface({ input: process.stdin, output: process.stdout })),
      (rl) => Effect.sync(() => rl.close()),
    )

    // A pending question never settles when input ends, so ending input is turned into a rejection.
    const closed = new Promise<never>((_, reject) => rl.once("close", () => reject(new Error("input closed"))))
    closed.catch(() => {})

    return Terminal.of({
      ask: (prompt) =>
        Effect.tryPromise({
          try: () => Promise.race([rl.question(prompt), closed]),
          catch: () => new InputClosed(),
        }),
      say: (line) => Effect.sync(() => console.log(line)),
      write: (text) => Effect.sync(() => void process.stdout.write(text)),
    })
  }),
)