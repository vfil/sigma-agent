import { Effect, Layer } from "effect"
import { repl } from "./agent"
import { ModelClientLive } from "./model-client"
import { SessionLive } from "./session"
import { TerminalLive } from "./terminal"
import { ToolsLive } from "./tools"

// The agent starts in playground/, so the default puts the database next to the project, outside the folder it works in.
const live = Layer.mergeAll(
  ModelClientLive,
  TerminalLive,
  ToolsLive,
  SessionLive({ path: process.env.DB_PATH ?? "../my-agent.db", id: process.env.SESSION ?? "default" }),
)

const fail = (error: { message: string }) =>
  Effect.sync(() => {
    console.error(error.message)
    process.exitCode = 1
  })

await Effect.runPromise(
  repl.pipe(
    Effect.provide(live),
    Effect.catchTags({ ConfigError: fail, SessionCorrupt: fail }),
  ),
)