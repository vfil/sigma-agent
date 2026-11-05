// The agent's own message types. No protocol appears in them.
export type TextPart = { type: "text"; text: string }
export type ToolCallPart = { type: "tool-call"; id: string; name: string; input: unknown }
export type ToolResultValue = { type: "text" | "error"; value: string }
export type ToolResultPart = { type: "tool-result"; id: string; name: string; result: ToolResultValue }
export type Part = TextPart | ToolCallPart | ToolResultPart

export type Message = {
  role: "user" | "assistant" | "tool"
  content: Part[]
  // The provider's own content for this message, kept so the same protocol can send it back unchanged.
  native?: unknown
}

export const isToolCall = (part: Part): part is ToolCallPart => part.type === "tool-call"
export const textOf = (message: Message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")