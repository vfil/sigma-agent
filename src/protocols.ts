import { Effect, Stream } from "effect"
import { messageOf, ProviderError } from "./errors"
import type { ModelEvent } from "./events"
import { isToolCall, textOf, type Message } from "./messages"
import type { Frame } from "./sse"
import type { Tool } from "./tool"

// A protocol turns the agent's types into one wire format, and the frames that come back into model events.
export type Protocol = {
  path: string
  body: (model: string, history: Message[], tools: Tool[]) => unknown
  events: (frames: Stream.Stream<Frame, ProviderError>) => Stream.Stream<ModelEvent, ProviderError>
}

// Folds the frames into events, one step per frame. The step gets the state so far and returns the new state
// and the events this frame completed. A step that throws, for example on malformed JSON, becomes a ProviderError.
const reduce =
  <S>(initial: S, step: (state: S, frame: Frame) => readonly [S, ModelEvent[]]) =>
  (frames: Stream.Stream<Frame, ProviderError>): Stream.Stream<ModelEvent, ProviderError> =>
    frames.pipe(
      Stream.mapAccumEffect(
        () => initial,
        (state, frame) =>
          Effect.try({
            try: () => step(state, frame),
            catch: (error) => new ProviderError({ reason: `Could not read the stream: ${messageOf(error)}` }),
          }),
      ),
    )

// OpenAI Chat Completions: what Ollama and llama.cpp speak. Only this section knows its wire format.
// Each chunk carries a `delta`: a piece of text, or a fragment of a tool call. Fragments of one call share an `index`.
type OpenAIChunk = {
  choices: {
    delta: {
      content?: string | null
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason: string | null
  }[]
}

// A tool call whose arguments are still arriving.
type PendingCall = { id: string; name: string; arguments: string }
type OpenAIState = { calls: Record<number, PendingCall> }

// OpenAI Chat Completions: what Ollama and llama.cpp speak. Only this section knows its wire format.
type OpenAIResponse = {
  choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]
}

const toOpenAITool = (tool: Tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
})

const toOpenAIMessages = (message: Message): unknown[] => {
  if (message.role === "tool") {
    // One role: "tool" message per result. There is no error flag, so the text carries the failure.
    return message.content.flatMap((part) =>
      part.type === "tool-result"
        ? [{ role: "tool", tool_call_id: part.id, content: part.result.type === "error" ? `Error: ${part.result.value}` : part.result.value }]
        : [],
    )
  }
  if (message.role === "assistant") {
    const calls = message.content.filter(isToolCall).map((call) => ({
      id: call.id,
      type: "function",
      // A string input is raw text that did not parse; send it back as it came.
      function: { name: call.name, arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input) },
    }))
    return [{ role: "assistant", content: textOf(message) || null, ...(calls.length ? { tool_calls: calls } : {}) }]
  }
  return [{ role: "user", content: textOf(message) }]
}

// Arguments arrive as a JSON string. If it does not parse, keep the raw text as the input.
const parseArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const stepOpenAI = (state: OpenAIState, frame: Frame): readonly [OpenAIState, ModelEvent[]] => {
  if (frame.data === "[DONE]") return [state, []]
  const choice = (JSON.parse(frame.data) as OpenAIChunk).choices[0]
  if (!choice) return [state, []]

  const events: ModelEvent[] = []
  if (choice.delta.content) events.push({ type: "text-delta", text: choice.delta.content })

  // The id and the name arrive in the first fragment of a call. Later fragments only add to the arguments.
  let calls = state.calls
  for (const fragment of choice.delta.tool_calls ?? []) {
    const call = calls[fragment.index] ?? { id: "", name: "", arguments: "" }
    calls = {
      ...calls,
      [fragment.index]: {
        id: fragment.id ?? call.id,
        name: fragment.function?.name ?? call.name,
        arguments: call.arguments + (fragment.function?.arguments ?? ""),
      },
    }
  }

  // The arguments are complete only when the model says it is done.
  if (choice.finish_reason) {
    const done = Object.values(calls)
    for (const call of done) events.push({ type: "tool-call", id: call.id, name: call.name, input: parseArguments(call.arguments) })
    events.push({ type: "finish", reason: done.length ? "tool-calls" : "stop" })
  }
  return [{ calls }, events]
}

export const openaiChat: Protocol = {
  path: "/chat/completions",
  body: (model, history, tools) => ({
    model,
    stream: true,
    messages: history.flatMap(toOpenAIMessages),
    reasoning_effort: "none",
    tools: tools.map(toOpenAITool),
  }),
  events: reduce<OpenAIState>({ calls: {} }, stepOpenAI),
}

// Anthropic Messages: what Claude speaks.
type AnthropicText = { type: "text"; text: string }
type AnthropicToolUse = { type: "tool_use"; id: string; name: string; input: unknown }
type AnthropicBlock = AnthropicText | AnthropicToolUse | { type: string } // e.g. thinking blocks

// The events this agent reads. Each block of the answer is opened, extended by deltas, and closed.
type AnthropicDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
type AnthropicEvent =
  | { type: "content_block_start"; content_block: AnthropicBlock }
  | { type: "content_block_delta"; index: number; delta: AnthropicDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null } }
  | { type: "message_stop" }
  | { type: "error"; error: { message: string } }
  | { type: "message_start" | "ping" }

// The blocks received so far, in order, and why the model stopped.
type AnthropicState = { blocks: AnthropicBlock[]; stop: string | null }

const isText = (block: AnthropicBlock): block is AnthropicText => block.type === "text"
const isToolUse = (block: AnthropicBlock): block is AnthropicToolUse => block.type === "tool_use"

// Same name and description as every other tool, but the schema is called input_schema.
const toAnthropicTool = (tool: Tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })

const toAnthropicMessage = (message: Message): unknown => {
  if (message.role === "tool") {
    // All the results of a step go back in one user message, and failures carry is_error.
    return {
      role: "user",
      content: message.content.flatMap((part) =>
        part.type === "tool-result"
          ? [{ type: "tool_result", tool_use_id: part.id, content: part.result.value, is_error: part.result.type === "error" }]
          : [],
      ),
    }
  }
  if (message.role === "assistant") {
    // Send back exactly what the model produced, thinking blocks included, when we kept it.
    if (message.native) return { role: "assistant", content: message.native }
    return {
      role: "assistant",
      content: message.content.flatMap((part): unknown[] =>
        part.type === "text"
          ? [{ type: "text", text: part.text }]
          : part.type === "tool-call"
            ? [{ type: "tool_use", id: part.id, name: part.name, input: part.input }]
            : [],
      ),
    }
  }
  return { role: "user", content: textOf(message) }
}

const stepAnthropic = (state: AnthropicState, frame: Frame): readonly [AnthropicState, ModelEvent[]] => {
  const event = JSON.parse(frame.data) as AnthropicEvent
  // The same blocks with the block at `index` extended.
  const extend = (index: number, extra: (block: AnthropicBlock) => object): AnthropicState => ({
    ...state,
    blocks: state.blocks.map((block, i) => (i === index ? { ...block, ...extra(block) } : block)),
  })

  switch (event.type) {
    case "content_block_start": {
      // While a tool_use block is open, its input holds the JSON text received so far.
      const block = event.content_block.type === "tool_use" ? { ...event.content_block, input: "" } : event.content_block
      return [{ ...state, blocks: [...state.blocks, block] }, []]
    }
    case "content_block_delta": {
      const delta = event.delta
      switch (delta.type) {
        case "text_delta":
          return [extend(event.index, (block) => ({ text: (isText(block) ? block.text : "") + delta.text })), delta.text ? [{ type: "text-delta", text: delta.text }] : []]
        case "input_json_delta":
          return [extend(event.index, (block) => ({ input: String(isToolUse(block) ? block.input : "") + delta.partial_json })), []]
        case "thinking_delta":
          return [extend(event.index, (block) => ({ thinking: String((block as { thinking?: string }).thinking ?? "") + delta.thinking })), []]
        case "signature_delta":
          return [extend(event.index, () => ({ signature: delta.signature })), []]
      }
      return [state, []]
    }
    case "content_block_stop": {
      const block = state.blocks[event.index]
      if (!block || !isToolUse(block)) return [state, []]
      // The arguments are complete now. If no argument text arrived, the call has none.
      const input = parseArguments(String(block.input) || "{}")
      return [extend(event.index, () => ({ input })), [{ type: "tool-call", id: block.id, name: block.name, input }]]
    }
    case "message_delta":
      return [{ ...state, stop: event.delta.stop_reason }, []]
    case "message_stop": {
      const reason = state.stop === "refusal" ? "refusal" : state.blocks.some(isToolUse) ? "tool-calls" : "stop"
      return [state, [{ type: "finish", reason, native: state.blocks }]]
    }
    case "error":
      throw new Error(event.error.message)
    default:
      return [state, []]
  }
}

export const anthropicMessages: Protocol = {
  path: "/v1/messages",
  body: (model, history, tools) => ({
    model,
    stream: true,
    max_tokens: 16000,
    messages: history.map(toAnthropicMessage),
    tools: tools.map(toAnthropicTool),
  }),
  events: reduce<AnthropicState>({ blocks: [], stop: null }, stepAnthropic),
}