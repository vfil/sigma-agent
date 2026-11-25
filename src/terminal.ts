import { Context, Effect, Layer } from "effect"
import { createInterface } from "node:readline"
import { InputClosed } from "./errors"
import { makeLines } from "./lines"

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

// The real terminal. Building the layer starts reading standard input; the end of the program stops it.
// readline only cuts the input into lines. It is given no output, so the terminal itself echoes what is typed,
// and a reply that is printed while the user types cannot disturb a line readline is redrawing.
export const TerminalLive = Layer.effect(
  Terminal,
  Effect.gen(function* () {
    const lines = makeLines()

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const rl = createInterface({ input: process.stdin })
        rl.on("line", lines.push)
        rl.on("close", lines.end)
        return rl
      }),
      (rl) => Effect.sync(() => rl.close()),
    )

    return Terminal.of({
      ask: (prompt) => Effect.sync(() => void process.stdout.write(prompt)).pipe(Effect.andThen(lines.next)),
      say: (line) => Effect.sync(() => console.log(line)),
      write: (text) => Effect.sync(() => void process.stdout.write(text)),
    })
  }),
)
