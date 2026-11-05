import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createInterface } from "node:readline/promises"

// The agent's own message types. No protocol appears in them.
type TextPart = { type: "text"; text: string }
type ToolCallPart = { type: "tool-call"; id: string; name: string; input: unknown }
type ToolResultValue = { type: "text" | "error"; value: string }
type ToolResultPart = { type: "tool-result"; id: string; name: string; result: ToolResultValue }
type Part = TextPart | ToolCallPart | ToolResultPart

type Message = {
  role: "user" | "assistant" | "tool"
  content: Part[]
  // The provider's own content for this message, kept so the same protocol can send it back unchanged.
  native?: unknown
}

type Tool = {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema, shared by both protocols
  execute: (input: unknown) => Promise<string>
  confirm?: (input: unknown) => string // describes the action; when set, the user must approve it first
}

// Reads one string field from model input, or throws a message that says how to fix it.
const field = (input: unknown, key: string, example: string): string => {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string, e.g. ${example}`)
  return value
}

const listFiles = async (path: string) => {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).join("\n")
}

const editFile = async (path: string, oldStr: string, newStr: string) => {
  if (oldStr === newStr) throw new Error("old_str and new_str must be different")

  if (oldStr === "") {
    if (existsSync(path)) throw new Error(`${path} already exists; pass the text to replace as old_str`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, newStr)
    return `Created ${path}`
  }

  const content = await readFile(path, "utf8")
  const matches = content.split(oldStr).length - 1
  if (matches === 0) throw new Error(`old_str was not found in ${path}`)
  if (matches > 1) throw new Error(`old_str matches ${matches} places in ${path}; include more surrounding text`)
  await writeFile(path, content.replace(oldStr, () => newStr))
  return "OK"
}

const saveFile = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return `Wrote ${content.length} characters to ${path}`
}

const TIMEOUT_MS = 30_000
const MAX_OUTPUT = 10_000

const runBash = (command: string) =>
  new Promise<string>((resolve, reject) => {
    execFile("bash", ["-c", command], { timeout: TIMEOUT_MS, maxBuffer: 10_000_000 }, (error, stdout, stderr) => {
      if (error?.killed) return reject(new Error(`The command ran longer than ${TIMEOUT_MS} ms and was stopped. Try a faster command.`))
      if (error && typeof error.code !== "number") return reject(error)
      const output = `${stdout}${stderr}`
      const shown =
        output.length > MAX_OUTPUT
          ? `${output.slice(0, MAX_OUTPUT)}\n[Output truncated after ${MAX_OUTPUT} characters. Filter it with head, tail or grep.]`
          : output
      resolve(`Exit code: ${error ? error.code : 0}\n${shown}`)
    })
  })

const rl = createInterface({ input: process.stdin, output: process.stdout })

const tools: Tool[] = [
  {
    name: "list_files",
    description:
      "List the files and directories at a path. Directory names end with a slash. Use it whenever you need to know what exists. Pass '.' for the current directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory to list, e.g. '.' or 'notes'" } },
      required: ["path"],
    },
    execute: (input) => listFiles(field(input, "path", "'.' or 'src'")),
  },
  {
    name: "read_file",
    description:
      "Read the full text contents of a file. Use it when you need to see what is inside a file. Do not use it on directories; use list_files for those.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path of the file to read, e.g. 'README.md'" } },
      required: ["path"],
    },
    execute: (input) => readFile(field(input, "path", "src/index.ts"), "utf8"),
  },
  {
    name: "edit_file",
    description:
      "Edit a text file by replacing old_str with new_str. old_str must match exactly one place in the file, character for character, including whitespace, so read the file first and copy it. To create a new file, use a path that does not exist and set old_str to an empty string; new_str becomes the whole file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to edit or create" },
        old_str: { type: "string", description: "Text to replace. Empty to create a new file." },
        new_str: { type: "string", description: "Text to put in its place" },
      },
      required: ["path", "old_str", "new_str"],
    },
    execute: (input) =>
      editFile(
        field(input, "path", "src/index.ts"),
        field(input, "old_str", "const a = 1 (or an empty string to create a file)"),
        field(input, "new_str", "const a = 2"),
      ),
    confirm: (input) => `edit ${field(input, "path", "src/index.ts")}`,
  },
  {
    name: "write_file",
    description:
      "Write a complete text file, replacing it if it already exists and creating missing folders. Use it to create a new file or to rewrite a file entirely. For a small change to an existing file, use edit_file instead, because it sends only the part that changes. The content you pass becomes the whole file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to write, e.g. 'notes/plan.md'" },
        content: { type: "string", description: "The full text of the file" },
      },
      required: ["path", "content"],
    },
    execute: (input) => saveFile(field(input, "path", "notes/plan.md"), field(input, "content", "the full text of the file")),
    confirm: (input) => `write ${field(input, "path", "notes/plan.md")}`,
  },
  {
    name: "bash",
    description:
      "Run a shell command with bash in the current directory and return its output and exit code. Use it for things the other tools cannot do, such as running a script, a test or git. Commands stop after 30 seconds and long output is cut off, so filter it with head, tail or grep when you expect a lot. Prefer read_file and list_files for reading, because they are cheaper and safer.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command to run, e.g. 'ls -la' or 'bun test'" } },
      required: ["command"],
    },
    execute: (input) => runBash(field(input, "command", "ls -la")),
    confirm: (input) => `run: ${field(input, "command", "ls -la")}`,
  },
]

// Never throws: every failure becomes a tool result the model can read.
const runTool = async (call: ToolCallPart): Promise<ToolResultPart> => {
  const done = (result: ToolResultValue): ToolResultPart => ({ type: "tool-result", id: call.id, name: call.name, result })

  try {
    const tool = tools.find((tool) => tool.name === call.name)
    if (!tool) throw new Error(`Unknown tool: ${call.name}. Available tools: ${tools.map((tool) => tool.name).join(", ")}`)

    // A string input is arguments that were not valid JSON; the protocol keeps the raw text.
    if (typeof call.input === "string") throw new Error(`The arguments are not valid JSON: ${call.input}`)

    if (tool.confirm) {
      const answer = await rl.question(`Allow: ${tool.confirm(call.input)}? [y/N] `)
      if (answer.trim().toLowerCase() !== "y") throw new Error("User declined this action. Ask what they would like instead.")
    }
    return done({ type: "text", value: await tool.execute(call.input) })
  } catch (error) {
    return done({ type: "error", value: error instanceof Error ? error.message : String(error) })
  }
}

type Reply = { message: Message; finish: "tool-calls" | "stop" | "refusal" }

// A protocol turns the agent's types into one wire format and back.
type Protocol = {
  path: string
  body: (model: string, history: Message[], tools: Tool[]) => unknown
  decode: (json: unknown) => Reply
}

const isToolCall = (part: Part): part is ToolCallPart => part.type === "tool-call"
const textOf = (message: Message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

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

const openaiChat: Protocol = {
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

const anthropicMessages: Protocol = {
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

// A route binds a protocol to one provider's endpoint and authentication.
type Route = { protocol: Protocol; baseUrl: string; headers: Record<string, string>; model: string }

const routes: Record<string, Route> = {
  ollama: { protocol: openaiChat, baseUrl: "http://127.0.0.1:11434/v1", headers: {}, model: "qwen3.5:9b" },
  llamacpp: { protocol: openaiChat, baseUrl: "http://127.0.0.1:9931/v1", headers: {}, model: "qwen3.5:9b" },
  claude: {
    protocol: anthropicMessages,
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2026-10-21" },
    model: "claude-sonnet-5-5",
  },
}

const providerName = process.env.PROVIDER ?? "ollama"
const selected = routes[providerName]
if (!selected) throw new Error(`Unknown PROVIDER "${providerName}". Choose one of: ${Object.keys(routes).join(", ")}`)
if (providerName === "claude" && !process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY first")

// BASE_URL and MODEL still override the route's defaults.
const route: Route = {
  ...selected,
  baseUrl: process.env.BASE_URL ?? selected.baseUrl,
  model: process.env.MODEL ?? selected.model,
}

const chat = async (history: Message[]): Promise<Reply> => {
  const response = await fetch(`${route.baseUrl}${route.protocol.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...route.headers },
    body: JSON.stringify(route.protocol.body(route.model, history, tools)),
  })
  if (!response.ok) throw new Error(await response.text())
  return route.protocol.decode(await response.json())
}

const history: Message[] = []

while (true) {
  const input = await rl.question("You: ")
  history.push({ role: "user", content: [{ type: "text", text: input }] })

  while (true) {
    const { message, finish } = await chat(history)
    history.push(message)
    for (const part of message.content) {
      if (part.type === "text" && part.text) console.log(`Agent: ${part.text}`)
    }
    if (finish !== "tool-calls") break

    const results: ToolResultPart[] = []
    for (const call of message.content.filter(isToolCall)) {
      console.log(`[tool] ${call.name}(${JSON.stringify(call.input)})`)
      const result = await runTool(call)
      if (result.result.type === "error") console.log(`[error] ${result.result.value}`)
      results.push(result)
    }
    history.push({ role: "tool", content: results })
  }
}