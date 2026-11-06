import { Effect, Layer } from "effect"
import { repl } from "./agent"
import { ModelClientLive } from "./model-client"
import { TerminalLive } from "./terminal"
import { ToolsLive } from "./tools"

const live = Layer.mergeAll(ModelClientLive, TerminalLive, ToolsLive)

await Effect.runPromise(
  repl([]).pipe(
    Effect.provide(live),
    Effect.catchTag("ConfigError", (error) =>
      Effect.sync(() => {
        console.error(error.message)
        process.exitCode = 1
      }),
    ),
  ),
)