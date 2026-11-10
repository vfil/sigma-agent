import { Schema } from "effect"

// The agent's own message types. No protocol appears in them. Each is a Schema, so the same definition
// that gives the type also checks the messages read back from the session log.
export const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
})
export const ToolResultValue = Schema.Struct({ type: Schema.Literals(["text", "error"]), value: Schema.String })
export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  result: ToolResultValue,
})
export const Part = Schema.Union([TextPart, ToolCallPart, ToolResultPart])

export const Message = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool"]),
  content: Schema.mutable(Schema.Array(Part)),
  // The provider's own content for this message, kept so the same protocol can send it back unchanged.
  native: Schema.optional(Schema.Unknown),
})

export type TextPart = typeof TextPart.Type
export type ToolCallPart = typeof ToolCallPart.Type
export type ToolResultValue = typeof ToolResultValue.Type
export type ToolResultPart = typeof ToolResultPart.Type
export type Part = typeof Part.Type
export type Message = typeof Message.Type

export const isToolCall = (part: Part): part is ToolCallPart => part.type === "tool-call"
export const textOf = (message: Message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")