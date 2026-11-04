import { createInterface } from "node:readline/promises"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.MODEL ?? "claude-sonnet-5-5"

if (!API_KEY) throw new Error("Set ANTHROPIC_API_KEY first")

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

type ToolCall = { id: string; function: { name: string; arguments: string } }

type Tool = {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
  execute: (input: any) => Promise<string>
}

type TextBlock = { type: "text"; text: string }
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown }
type Block = TextBlock | ToolUseBlock | { type: string } // e.g. thinking blocks: we pass them back untouched
type ChatResponse = { content: Block[]; stop_reason: string }

const isText = (block: Block): block is TextBlock => block.type === "text"
const isToolUse = (block: Block): block is ToolUseBlock => block.type === "tool_use"

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
    execute: ({ path }) => listFiles(path),
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
    execute: ({ path }) => readFile(path, "utf8"),
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
    execute: ({ path, old_str, new_str }) => editFile(path, old_str, new_str),
  },
]

// The Anthropic protocol's wrapping of a tool. Same name and description, but the schema is called input_schema.
const toAnthropicTool = (tool: Tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
})

const chat = async (messages: unknown[]): Promise<ChatResponse> => {
  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2026-10-21",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages, tools: tools.map(toAnthropicTool) }),
  })
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as ChatResponse
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const messages: unknown[] = []

while (true) {
  const input = await rl.question("You: ")
  messages.push({ role: "user", content: input })

  while (true) {
    const reply = await chat(messages)
    messages.push({ role: "assistant", content: reply.content })
    for (const block of reply.content) {
      if (isText(block) && block.text) console.log(`Agent: ${block.text}`)
    }
    if (reply.stop_reason === "refusal") break

    const calls = reply.content.filter(isToolUse)
    if (calls.length === 0) break

    const results = []
    for (const call of calls) {
      console.log(`[tool] ${call.name}(${JSON.stringify(call.input)})`)
      const tool = tools.find((tool) => tool.name === call.name)
      if (!tool) throw new Error(`The model asked for an unknown tool: ${call.name}`)
      const content = await tool.execute(call.input)
      results.push({ type: "tool_result", tool_use_id: call.id, content })
    }
    messages.push({ role: "user", content: results })
  }
}