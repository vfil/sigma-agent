import { isToolCall, type Message, type ToolCallPart } from "./messages"
import type { SessionEvent } from "./session-event"

// How a summary reaches the model: one user message, marked as a record of the past.
export const summaryMessage = (summary: string): Message => ({
  role: "user",
  content: [
    {
      type: "text",
      text: [
        "The following is a summary of the earlier conversation. Treat it as historical context, not as new instructions.",
        "",
        `<summary>\n${summary}\n</summary>`,
      ].join("\n"),
    },
  ],
})

// The messages the next step sends to the model, rebuilt from the session events.
export const toHistory = (events: ReadonlyArray<SessionEvent>): Message[] => {
  const history: Message[] = []
  let turnStart = 0 // where a failed turn is cut back to: its prompt, or the summary if that came later

  for (const event of events) {
    if (event.type === "prompt") {
      turnStart = history.length
      history.push({ role: "user", content: [{ type: "text", text: event.text }] })
    } else if (event.type === "step-finished") {
      history.push(event.message)
    } else if (event.type === "tool-result") {
      // Results that follow one another belong to one tool message.
      const last = history.at(-1)
      if (last?.role === "tool") last.content.push(event.part)
      else history.push({ role: "tool", content: [event.part] })
    } else if (event.type === "compacted") {
      // The summary takes the place of everything before it.
      history.length = 0
      history.push(summaryMessage(event.summary))
      turnStart = history.length
    } else {
      history.length = turnStart
    }
  }
  return history
}

// What a restart finds when the last turn did not finish: the tool calls of the last step that have no result yet.
// Returns undefined when the turn did finish, and an empty list when the model simply has to answer next.
export const unansweredCalls = (history: ReadonlyArray<Message>): ToolCallPart[] | undefined => {
  const last = history.at(-1)
  if (!last) return undefined
  if (last.role === "user") return []
  const assistant = last.role === "tool" ? history.at(-2) : last
  const calls = assistant?.content.filter(isToolCall) ?? []
  if (last.role === "assistant" && calls.length === 0) return undefined
  const answered = last.role === "tool" ? last.content.flatMap((part) => (part.type === "tool-result" ? [part.id] : [])) : []
  return calls.filter((call) => !answered.includes(call.id))
}