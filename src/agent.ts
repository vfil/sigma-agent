import { Effect, Queue, Stream } from "effect"
import { messageOf, type InputClosed, type ProviderError, type SessionCorrupt } from "./errors"
import type { FinishReason } from "./events"
import { unansweredCalls } from "./history"
import { isToolCall, type Message, type Part } from "./messages"
import { ModelClient } from "./model-client"
import { Session } from "./session"
import { Terminal } from "./terminal"
import { runTool, Tools, type Tool } from "./tool"

// One step: reload the history from the log, stream the model's events, show the text as it arrives,
// and append the finished message to the log.
const step = (tools: Tool[]) =>
  Effect.gen(function* () {
    const model = yield* ModelClient
    const terminal = yield* Terminal
    const session = yield* Session
    const history = yield* session.history
    const content: Part[] = []
    let text = "" // the text block being written, if any
    const outcome: { finish: FinishReason; native?: unknown } = { finish: "stop" }

    // A text block ends when anything else arrives, or when the stream does, even by failing.
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
      }),
    ).pipe(Effect.ensuring(endText))

    const message: Message = { role: "assistant", content, ...(outcome.native === undefined ? {} : { native: outcome.native }) }
    yield* session.append({ type: "step-finished", message, finish: outcome.finish })
    return { message, finish: outcome.finish }
  })

// Steps until the model stops asking for tools. Each result is appended as soon as its tool finishes.
const run = Effect.gen(function* () {
  const terminal = yield* Terminal
  const session = yield* Session
  const tools = yield* Tools

  while (true) {
    const { message, finish } = yield* step(tools)
    if (finish !== "tool-calls") return

    for (const call of message.content.filter(isToolCall)) {
      yield* terminal.say(`[tool] ${call.name}(${JSON.stringify(call.input)})`)
      const part = yield* runTool(call)
      if (part.result.type === "error") yield* terminal.say(`[error] ${part.result.value}`)
      yield* session.append({ type: "tool-result", part })
    }
  }
})

const interrupted =
  "The agent stopped before this tool finished, so it may or may not have run. Check the current state before repeating it."

// A restart can find a turn that did not finish. Tool calls without a result get an error result instead of
// running again, since a command that already ran must not run twice. Then the turn continues.
const resume = Effect.gen(function* () {
  const terminal = yield* Terminal
  const session = yield* Session
  const calls = unansweredCalls(yield* session.history)
  if (calls === undefined) return

  yield* terminal.say(`[resuming session ${session.id}]`)
  for (const call of calls) {
    yield* terminal.say(`[interrupted] ${call.name}(${JSON.stringify(call.input)})`)
    yield* session.append({
      type: "tool-result",
      part: { type: "tool-result", id: call.id, name: call.name, result: { type: "error", value: interrupted } },
    })
  }
  yield* run
})

const queued = (count: number) => `${count} queued prompt${count === 1 ? "" : "s"}`

// The read-eval-print loop, in two halves that do not wait for each other.
// - The reader asks for a line, saves it in the inbox, and asks again, even while a turn is running.
// - The worker finishes an interrupted turn, then delivers one prompt at a time and runs its turn.
// The reader rings a bell after each prompt. The ring carries no prompt: it only tells the worker to look at the inbox.
export const repl = Effect.gen(function* () {
  const terminal = yield* Terminal
  const session = yield* Session

  // A turn that fails is recorded as failed, so the next prompt starts from a consistent history.
  const failed = (label: string, reason: string) =>
    session.append({ type: "turn-failed", reason }).pipe(Effect.andThen(terminal.say(`[${label}] ${reason}`)))
  const guarded = <R>(work: Effect.Effect<void, ProviderError | SessionCorrupt | InputClosed, R>) =>
    work.pipe(
      Effect.catchTag("ProviderError", (error) => failed("provider error", error.message)),
      Effect.catchDefect((defect) => failed("bug", messageOf(defect))),
    )

  // At most one ring waits at a time: two rings in a row mean the same thing as one.
  const wake = yield* Queue.dropping<void>(1)
  let inputEnded = false

  const reader = Effect.gen(function* () {
    while (true) {
      const input = yield* terminal.ask("You: ")
      yield* session.admit(input)
      yield* terminal.say("[queued]")
      yield* Queue.offer(wake, undefined)
    }
  }).pipe(
    Effect.catchTag("InputClosed", () => Effect.sync(() => void (inputEnded = true))),
    Effect.andThen(Queue.offer(wake, undefined)),
  )

  // What the last run left in the inbox, counted before the reader can add anything.
  const left = yield* session.pending
  if (left > 0) yield* terminal.say(`[${queued(left)} from an earlier run]`)

  yield* Effect.forkChild(reader)
  yield* guarded(resume)

  while (true) {
    // Read before delivering: a prompt admitted before the input ended is then always found by the delivery below.
    const ended = inputEnded
    if ((yield* session.deliver) !== undefined) {
      yield* guarded(run)
      continue
    }
    if (ended) return
    yield* Queue.take(wake)
  }
})