import { isToolCall, textOf, type Message, type Part } from "./messages"
import type { Tool } from "./tool"

export type Reply = { message: Message; finish: "tool-calls" | "stop" | "refusal" }

// A protocol turns the agent's types into one wire format and back.
export type Protocol = {
  path: string
  body: (model: string, history: Message[], tools: Tool[]) => unknown
  decode: (json: unknown) => Reply
}

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

export const openaiChat: Protocol = {
  path: "/chat/completions",
  body: (model, history, tools) => ({
    model,
    messages: history.flatMap(toOpenAIMessages),
    reasoning_effort: "none",
    tools: tools.map(toOpenAITool),
  }),
  decode: (json) => {
    const message = (json as OpenAIResponse).choices[0]?.message
    if (!message) throw new Error("No choices returned from model")
    const content: Part[] = []
    if (message.content) content.push({ type: "text", text: message.content })
    for (const call of message.tool_calls ?? []) {
      content.push({ type: "tool-call", id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) })
    }
    return { message: { role: "assistant", content }, finish: content.some(isToolCall) ? "tool-calls" : "stop" }
  },
}

// Anthropic Messages: what Claude speaks.
type AnthropicText = { type: "text"; text: string }
type AnthropicToolUse = { type: "tool_use"; id: string; name: string; input: unknown }
type AnthropicBlock = AnthropicText | AnthropicToolUse | { type: string } // e.g. thinking blocks
type AnthropicResponse = { content: AnthropicBlock[]; stop_reason: string }

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

export const anthropicMessages: Protocol = {
  path: "/v1/messages",
  body: (model, history, tools) => ({
    model,
    max_tokens: 16000,
    messages: history.map(toAnthropicMessage),
    tools: tools.map(toAnthropicTool),
  }),
  decode: (json) => {
    const data = json as AnthropicResponse
    const content: Part[] = []
    for (const block of data.content) {
      if (isText(block)) content.push({ type: "text", text: block.text })
      else if (isToolUse(block)) content.push({ type: "tool-call", id: block.id, name: block.name, input: block.input })
    }
    const finish = data.stop_reason === "refusal" ? "refusal" : content.some(isToolCall) ? "tool-calls" : "stop"
    return { message: { role: "assistant", content, native: data.content }, finish }
  },
}