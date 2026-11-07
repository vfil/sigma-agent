import { Effect, Stream } from "effect"
import { messageOf } from "./errors"
import type { FinishReason } from "./events"
import { isToolCall, type Message, type Part, type ToolResultPart } from "./messages"
import { ModelClient } from "./model-client"
import { Terminal } from "./terminal"
import { runTool, Tools, type Tool } from "./tool"

// One step: stream the model's events, show the text as it arrives, and build the assistant message from them.
const step = (history: Message[], tools: Tool[]) =>
  Effect.gen(function* () {
    const model = yield* ModelClient
    const terminal = yield* Terminal
    const content: Part[] = []
    let text = "" // the text block being written, if any
    const outcome: { finish: FinishReason; native?: unknown } = { finish: "stop" }

    // A text block ends when anything else arrives, or when the stream does.
    const endText = Effect.suspend(() => {
      if (!text) return Effect.void
      content.push({ type: "text", text })
      text = ""
      return terminal.say("")
    })

    yield* Stream.runForEach(model.chat(history, tools), (event) =>
      Effect.gen(function* () {
        if (event.type === "text-delta") {
          if (!text) yield* terminal.write("Agent: ")
          text += event.text
          yield* terminal.write(event.text)
          return
        }
        yield* endText
        if (event.type === "tool-call") content.push(event)
        else {
          outcome.finish = event.reason
          outcome.native = event.native
        }
      })
    ).pipe(Effect.ensuring(endText))

    const message: Message = { role: "assistant", content, ...(outcome.native === undefined ? {} : { native: outcome.native }) }
    return { message, finish: outcome.finish }
  })

// One prompt: call the model until it stops asking for tools.
export const turn = (history: Message[], input: string) =>
  Effect.gen(function* () {
    const terminal = yield* Terminal
    const tools = yield* Tools
    history.push({ role: "user", content: [{ type: "text", text: input }] })

    while (true) {
      const { message, finish } = yield* step(history, tools)
      history.push(message)
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