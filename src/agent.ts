import { Effect } from "effect"
import { messageOf } from "./errors"
import { isToolCall, type Message, type ToolResultPart } from "./messages"
import { Terminal } from "./terminal"
import { runTool, Tools } from "./tool"
import { ModelClient } from "./model-client"

// One prompt: call the model until it stops asking for tools.
export const turn = (history: Message[], input: string) =>
  Effect.gen(function* () {
    const model = yield* ModelClient
    const terminal = yield* Terminal
    const tools = yield* Tools
    history.push({ role: "user", content: [{ type: "text", text: input }] })

    while (true) {
      const { message, finish } = yield* model.chat(history, tools)
      history.push(message)
      for (const part of message.content) {
        if (part.type === "text" && part.text) yield* terminal.say(`Agent: ${part.text}`)
      }
      if (finish !== "tool-calls") return

      const results: ToolResultPart[] = []
      for (const call of message.content.filter(isToolCall)) {
        yield* terminal.say(`[tool] ${call.name}(${JSON.stringify(call.input)})`)
        const result = yield* runTool(call)
        if (result.result.type === "error") yield* terminal.say(`[error] ${result.result.value}`)
        results.push(result)
      }
      history.push({ role: "tool", content: results })
    }
  })

// The read-eval-print loop: read a line from the user, run a turn on it, print the output, and repeat.
export const repl = (history: Message[]) =>
  Effect.gen(function* () {
    const terminal = yield* Terminal
    while (true) {
      const input = yield* terminal.ask("You: ")

      // A turn that fails is dropped from the history, so the next prompt starts from a consistent conversation.
      const before = history.length
      const drop = (label: string, reason: string) =>
        Effect.suspend(() => {
          history.length = before
          return terminal.say(`[${label}] ${reason}`)
        })

      yield* turn(history, input).pipe(
        Effect.catchTag("ProviderError", (error) => drop("provider error", error.message)),
        Effect.catchDefect((defect) => drop("bug", messageOf(defect))),
      )
    }
  }).pipe(Effect.catchTag("InputClosed", () => Effect.void))