// What a step produces while the model is answering. The agent builds its message from these events.
export type FinishReason = "tool-calls" | "stop" | "refusal"

export type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  // The last event of a step. `native` is the provider's own content, kept so the same protocol can send it back.
  | { type: "finish"; reason: FinishReason; native?: unknown }