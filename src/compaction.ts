import { Effect, Stream } from "effect"
import { ProviderError, type SessionCorrupt } from "./errors"
import { toHistory } from "./history"
import type { Message, Part } from "./messages"
import { ModelClient } from "./model-client"
import { Session } from "./session"
import { Terminal } from "./terminal"
import type { Tool } from "./tool"

// A rough count of what one step sends: the history and the tool definitions, at about four characters per token.
// JSON.stringify leaves out each tool's `run` function, which never goes to the model.
export const estimateTokens = (history: ReadonlyArray<Message>, tools: ReadonlyArray<Tool>) =>
  Math.ceil(JSON.stringify([history, tools]).length / 4)

// The share of the window kept free for the model's reply, and for the summary when it is written.
const RESERVE = 0.25

export const isDue = (estimate: number, contextWindow: number) => estimate >= contextWindow * (1 - RESERVE)

// Tool results and tool inputs, such as the content of a file to write, can be long. In the summary request
// each one keeps its first characters only.
const CLIP = 2_000

const clip = (text: string) => (text.length <= CLIP ? text : `${text.slice(0, CLIP)}\n[... ${text.length - CLIP} more characters]`)

const partToText = (part: Part) => {
  if (part.type === "text") return part.text
  if (part.type === "tool-call") return `[called ${part.name}(${clip(JSON.stringify(part.input))})]`
  return `[${part.name} ${part.result.type === "error" ? "failed" : "returned"}]\n${clip(part.result.value)}`
}

// The history as plain text. The summary request carries no tools, and some providers refuse tool calls and
// results in a request that defines no tools, so the conversation goes out as one text instead.
export const transcript = (history: ReadonlyArray<Message>) =>
  history
    .map((message) => {
      const who = message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool results" : "User"
      return `${who}:\n${message.content.map(partToText).join("\n")}`
    })
    .join("\n\n")

// A shorter version of OpenCode's summary template, for a small model.
export const SUMMARY_PROMPT = `Summarize the conversation above for another agent that will continue the work. That agent will see only your summary, not the conversation.

Use this format, and write "(none)" under a heading that has nothing to say:

## Objective
- [what the user is trying to accomplish, in one or two sentences]

## Decisions
- [decisions already made, and why]

## Work state
- [what is done, what is in progress, what is blocked]

## Next move
1. [the next actions, in order]

## Relevant files
- [path]: [why it matters]

## Latest request
[the user's latest request that is not yet fully answered, quoted word for word]

Rules:
- Use short, single-line bullets.
- Keep exact file paths, commands, error messages and identifiers.
- Do not continue the task and do not call tools. Return only the summary.`

const summaryRequest = (history: ReadonlyArray<Message>): Message[] => [
  {
    role: "user",
    content: [{ type: "text", text: `<conversation>\n${transcript(history)}\n</conversation>\n\n${SUMMARY_PROMPT}` }],
  },
]

// Runs before every step. When the next request would come close to the window, the model writes a summary
// of the history so far, and the summary is appended to the log. The next step then starts from it.
export const compactIfDue = (tools: Tool[]): Effect.Effect<void, ProviderError | SessionCorrupt, ModelClient | Session | Terminal> =>
  Effect.gen(function* () {
    const model = yield* ModelClient
    const session = yield* Session
    const terminal = yield* Terminal

    const events = yield* session.events
    // Right after a compaction the history cannot get any shorter, so the step goes out as it is.
    if (events.at(-1)?.type === "compacted") return
    const history = toHistory(events)
    const before = estimateTokens(history, tools)
    if (!isDue(before, model.contextWindow)) return

    yield* terminal.say(`[compacting: ~${before} tokens]`)
    const summary = yield* model.chat(summaryRequest(history), []).pipe(
      Stream.runFold(
        () => "",
        (text, event) => (event.type === "text-delta" ? text + event.text : text),
      ),
      Effect.map((text) => text.trim()),
    )
    if (!summary) return yield* new ProviderError({ reason: "The model returned an empty summary" })

    yield* session.append({ type: "compacted", summary })
    const after = estimateTokens(toHistory([...events, { type: "compacted", summary }]), tools)
    yield* terminal.say(`[compacted: ${before} → ${after} tokens]`)
  })