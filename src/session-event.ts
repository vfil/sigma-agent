import { Schema } from "effect"
import { Message, ToolResultPart } from "./messages"

// The facts a session records. Nothing here can be worked out from the other events.
export const Prompt = Schema.Struct({ type: Schema.Literal("prompt"), text: Schema.String })

// One finished model call: the whole assistant message and why the step ended.
export const StepFinished = Schema.Struct({
  type: Schema.Literal("step-finished"),
  message: Message,
  finish: Schema.Literals(["tool-calls", "stop", "refusal"]),
})

// One tool call's result. A step with three calls appends three of these, one as soon as each finishes.
export const ToolResult = Schema.Struct({ type: Schema.Literal("tool-result"), part: ToolResultPart })

// The turn ended in an error. The history leaves the turn out; the log keeps it.
export const TurnFailed = Schema.Struct({ type: Schema.Literal("turn-failed"), reason: Schema.String })

export const SessionEvent = Schema.Union([Prompt, StepFinished, ToolResult, TurnFailed])
export type SessionEvent = typeof SessionEvent.Type