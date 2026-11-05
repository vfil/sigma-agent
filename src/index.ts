import { Effect } from "effect"
import { messageOf } from "./errors"
import { isToolCall, type Message, type ToolResultPart } from "./messages"
import { chat } from "./provider"
import { ask } from "./terminal"
import { runTool } from "./tool"
import { tools } from "./tools"

const history: Message[] = []

// One prompt: call the model until it stops asking for tools.
const turn = (input: string) =>
  Effect.gen(function* () {
    history.push({ role: "user", content: [{ type: "text", text: input }] })

    while (true) {
      const { message, finish } = yield* chat(history, tools)
      history.push(message)
      for (const part of message.content) {
        if (part.type === "text" && part.text) console.log(`Agent: ${part.text}`)
      }
      if (finish !== "tool-calls") return

      const results: ToolResultPart[] = []
      for (const call of message.content.filter(isToolCall)) {
        console.log(`[tool] ${call.name}(${JSON.stringify(call.input)})`)
        const result = yield* runTool(tools, call)
        if (result.result.type === "error") console.log(`[error] ${result.result.value}`)
        results.push(result)
      }
      history.push({ role: "tool", content: results })
    }
  })

const program = Effect.gen(function* () {
  while (true) {
    const input = yield* ask("You: ")

    // A turn that fails is dropped from the history, so the next prompt starts from a consistent conversation.
    const before = history.length
    const drop = (label: string, reason: string) =>
      Effect.sync(() => {
        history.length = before
        console.log(`[${label}] ${reason}`)
      })

    yield* turn(input).pipe(
      Effect.catchTag("ProviderError", (error) => drop("provider error", error.message)),
      Effect.catchDefect((defect) => drop("bug", messageOf(defect))),
    )
  }
}).pipe(Effect.catchTag("InputClosed", () => Effect.void))

await Effect.runPromise(program)