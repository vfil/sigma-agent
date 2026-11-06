import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Layer, Schema } from "effect"
import { defineTool, Tools, type Tool } from "./tool"

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

export const tools: Tool[] = [
  defineTool({
    name: "list_files",
    description:
      "List the files and directories at a path. Directory names end with a slash. Use it whenever you need to know what exists. Pass '.' for the current directory.",
    input: Schema.Struct({
      path: Schema.String.annotate({ description: "Directory to list, e.g. '.' or 'notes'" }),
    }),
    execute: ({ path }) => listFiles(path),
  }),
  defineTool({
    name: "read_file",
    description:
      "Read the full text contents of a file. Use it when you need to see what is inside a file. Do not use it on directories; use list_files for those.",
    input: Schema.Struct({
      path: Schema.String.annotate({ description: "Path of the file to read, e.g. 'README.md'" }),
    }),
    execute: ({ path }) => readFile(path, "utf8"),
  }),
  defineTool({
    name: "edit_file",
    description:
      "Edit a text file by replacing old_str with new_str. old_str must match exactly one place in the file, character for character, including whitespace, so read the file first and copy it. To create a new file, use a path that does not exist and set old_str to an empty string; new_str becomes the whole file.",
    input: Schema.Struct({
      path: Schema.String.annotate({ description: "Path of the file to edit or create" }),
      old_str: Schema.String.annotate({ description: "Text to replace. Empty to create a new file." }),
      new_str: Schema.String.annotate({ description: "Text to put in its place" }),
    }),
    execute: ({ path, old_str, new_str }) => editFile(path, old_str, new_str),
    confirm: ({ path }) => `edit ${path}`,
  }),
  defineTool({
    name: "write_file",
    description:
      "Write a complete text file, replacing it if it already exists and creating missing folders. Use it to create a new file or to rewrite a file entirely. For a small change to an existing file, use edit_file instead, because it sends only the part that changes. The content you pass becomes the whole file.",
    input: Schema.Struct({
      path: Schema.String.annotate({ description: "Path of the file to write, e.g. 'notes/plan.md'" }),
      content: Schema.String.annotate({ description: "The full text of the file" }),
    }),
    execute: ({ path, content }) => saveFile(path, content),
    confirm: ({ path }) => `write ${path}`,
  }),
  defineTool({
    name: "bash",
    description:
      "Run a shell command with bash in the current directory and return its output and exit code. Use it for things the other tools cannot do, such as running a script, a test or git. Commands stop after 30 seconds and long output is cut off, so filter it with head, tail or grep when you expect a lot. Prefer read_file and list_files for reading, because they are cheaper and safer.",
    input: Schema.Struct({
      command: Schema.String.annotate({ description: "The command to run, e.g. 'ls -la' or 'bun test'" }),
    }),
    execute: ({ command }) => runBash(command),
    confirm: ({ command }) => `run: ${command}`,
  }),
]

export const ToolsLive = Layer.succeed(Tools, tools)