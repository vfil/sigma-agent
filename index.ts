import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createInterface } from "node:readline/promises"

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:11434/v1"
const MODEL = process.env.MODEL ?? "qwen3.5:9b"

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

type ToolResult = { content: string; isError: boolean }

// Never throws: every failure becomes a result the model can read.
const runTool = async (name: string, rawArguments: string): Promise<ToolResult> => {
  try {
    const tool = tools.find((tool) => tool.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}. Available tools: ${tools.map((tool) => tool.name).join(", ")}`)

    let input: unknown
    try {
      input = JSON.parse(rawArguments)
    } catch {
      throw new Error(`The arguments are not valid JSON: ${rawArguments}`)
    }

    if (tool.confirm) {
      const answer = await rl.question(`Allow: ${tool.confirm(input)}? [y/N] `)
      if (answer.trim().toLowerCase() !== "y") throw new Error("User declined this action. Ask what they would like instead.")
    }
    return { content: await tool.execute(input), isError: false }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}

// The OpenAI protocol's wrapping of a tool. Only this function knows about the wire format.
const toOpenAITool = (tool: Tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
})

type ToolCall = { id: string; function: { name: string; arguments: string } }
type Message = { role: string; content: string | null; tool_calls?: ToolCall[] }
type ChatResponse = { choices: { message: Message }[] }

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
      const { content, isError } = await runTool(call.function.name, call.function.arguments)
      if (isError) console.log(`[error] ${content}`)
      messages.push({ role: "tool", tool_call_id: call.id, content: isError ? `Error: ${content}` : content })
    }
  }
}