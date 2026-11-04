import { createInterface } from "node:readline/promises"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

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

// llama.cpp as default, set env BASE_URL = "http://127.0.0.1:11434/v1" to use ollama
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:9931/v1"
const MODEL = process.env.MODEL ?? "qwen3.5:9b"

type ToolCall = { id: string; function: { name: string; arguments: string } }
type Message = { role: string; content: string | null; tool_calls?: ToolCall[] }
type ChatResponse = { choices: { message: Message }[] }

type Tool = {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
  execute: (input: any) => Promise<string>
}

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

// The OpenAI protocol's wrapping of a tool. Only this function knows about the wire format.
const toOpenAITool = (tool: Tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
})

const chat = async (messages: unknown[]): Promise<Message> => {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, reasoning_effort: "none", tools: tools.map(toOpenAITool) }),
  })
  if (!response.ok) throw new Error(await response.text())
  const data = (await response.json()) as ChatResponse
  const message = data.choices[0]?.message
  if (!message) throw new Error("No choices returned from model")
  return message
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const messages: unknown[] = []

while (true) {
  const input = await rl.question("You: ")
  messages.push({ role: "user", content: input })

  while (true) {
    const message = await chat(messages)
    messages.push(message)
    if (message.content) console.log(`Agent: ${message.content}`)
    if (!message.tool_calls?.length) break

    for (const call of message.tool_calls) {
      console.log(`[tool] ${call.function.name}(${call.function.arguments})`)
      const tool = tools.find((tool) => tool.name === call.function.name)
      if (!tool) throw new Error(`The model asked for an unknown tool: ${call.function.name}`)
      const content = await tool.execute(JSON.parse(call.function.arguments))
      messages.push({ role: "tool", tool_call_id: call.id, content })
    }
  }
}