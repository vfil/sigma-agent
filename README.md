# sigma-agent

A minimal coding-agent in a single file, written to show how an LLM agent works without a framework.

You chat with it in the terminal. The model can't touch your files directly. It can only ask the program to run one of five **tools** (see [GLOSSARY.md](GLOSSARY.md) for the terms used here), and the program runs the tool and feeds the result back. Tools that change things ask you to confirm first.

| Tool         | What it does                                                                                              | Confirms first? |
| ------------ | --------------------------------------------------------------------------------------------------------- | --------------- |
| `list_files` | List a directory (directories end with `/`)                                                               | No              |
| `read_file`  | Read a text file                                                                                          | No              |
| `edit_file`  | Replace one exact piece of text in a file, or create a file (`old_str` empty)                             | Yes             |
| `write_file` | Write a whole file, replacing it if it exists and creating missing folders                                | Yes             |
| `bash`       | Run a shell command in the current directory and return its exit code and output (stops after 30 s, output cut at 10,000 characters) | Yes             |

## How it works

```
You: <prompt>
  └─► send full message history + tool definitions to the model
        ├─ model replies with text         ─► print "Agent: ..."
        └─ model asks for tool call(s)     ─► for each one, print "[tool] name(args)", then:
              ├─ tool needs confirmation   ─► ask "Allow: ...? [y/N]"; anything but "y" declines
              ├─ run the tool              ─► result
              └─ any failure               ─► print "[error] ...", and the error text becomes the result
            append the results, call the model again
      (repeat until the model answers without a tool call, then wait for your next prompt)
```

Every failure (unknown tool, invalid JSON arguments, a missing or wrong-typed field, a declined confirmation, a command timeout, a missing file) is sent back to the model as an error result instead of crashing the program, so the model can read it and try something else.

The whole conversation lives in memory (`messages`) and is lost when the process exits.

## Adding a tool

A tool is a plain object in the `tools` array:

```ts
{
  name: "word_count",
  description: "Count the words in a text file.",          // the model reads this to decide when to use it
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, // JSON Schema
  execute: async (input) => String((await readFile(field(input, "path", "notes.txt"), "utf8")).split(/\s+/).length),
  confirm: (input) => `count words in ${field(input, "path", "notes.txt")}`, // optional: set it to require confirmation
}
```

`runTool` looks the tool up, parses the arguments, asks for confirmation when `confirm` is set, runs `execute`, and turns any thrown error into an error result. `field()` reads a string argument and throws a message that tells the model how to fix it. The `tools` array and `runTool` are duplicated in both entry points, so add a new tool to both files.

## Two entry points

Both files are the same agent loop with the same tools. They differ only in the wire protocol of the model provider.

| File                 | Provider                                                | Config (env vars)                                                                              |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [index.ts](index.ts)   | Any OpenAI-compatible server (local llama.cpp, Ollama…) | `BASE_URL` (default `http://127.0.0.1:9931/v1`), `MODEL` (default `qwen3.5:9b`)                |
| [claude.ts](claude.ts) | Anthropic API                                           | `ANTHROPIC_API_KEY` (required), `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`), `MODEL` (default `claude-sonnet-5-5`) |

`index.ts` is the main path. By default it expects a llama.cpp server on port `9931`. To use Ollama instead, set `BASE_URL=http://127.0.0.1:11434/v1`.

## Setup

Requires [Bun](https://bun.com). The project uses Bun for everything (see [CLAUDE.md](CLAUDE.md)).

```bash
bun install
bun check        # type check (same as `bun run typecheck`)
```

## Try it (manual smoke test)

There are no automated tests. To check the agent works end to end, run it against the [playground/](playground/) folder, which contains a riddle in `secret-file.txt`.

> **Warning:** the tools are not sandboxed. Paths are resolved against the directory you launch from and absolute paths work. `bash` can run any command as your user, and `edit_file` and `write_file` can create or overwrite any file you can write. The only protection is the confirmation prompt, so read the path or command it shows before typing `y`. Always run the agent from `playground/`, not from a directory you care about.

1. Make sure a model is available:
   - **`index.ts`**: start your OpenAI-compatible server (llama.cpp on `:9931` by default, or Ollama with `BASE_URL` set as above).
   - **`claude.ts`**: `export ANTHROPIC_API_KEY=...`
2. Start the agent from inside `playground/`:

   ```bash
   cd playground
   bun ../index.ts      # or: bun ../claude.ts
   ```

3. Ask it about the riddle. Example session:

   ```
   You: Hello!
   Agent: Hello! How can I help you today?
   You: There is a text file in this directory with a riddle in it. What's the answer to the riddle?
   [tool] list_files({"path":"."})
   [tool] read_file({"path":"secret-file.txt"})
   Agent: The answer to the riddle is **a keyboard**.

   Here's why:
   - "I have keys but no locks" - A keyboard has keys (the buttons) but no physical locks
   - "I have space but no room" - A keyboard has a "space" bar, but no actual room
   - "You can enter, but you can't go outside" - You can enter data (type on it), but you can't exit the keyboard itself

   Classic riddle!
   ```

**What to look for:** the `[tool] ...` lines show the model chose to list the directory and then read the file before answering. Exact wording varies between runs and models. What matters is that tool calls happen and the answer is "a keyboard".

You can also try a tool that changes things, for example *"add 'call mom' to notes/todo.txt"*. The agent stops and asks before it edits:

```
[tool] edit_file({"path":"notes/todo.txt","old_str":"- water the plants","new_str":"- water the plants\n- call mom"})
Allow: edit notes/todo.txt? [y/N]
```

Type `y` to let it run. Anything else declines, and the model is told so and can ask what you'd like instead. Afterwards check `playground/notes/todo.txt` (use `git diff` to review and `git checkout playground` to undo).

Press `Ctrl+C` to quit.

## Known limitations

- No sandboxing, no streaming, no history persistence.
- Confirmation covers only `edit_file`, `write_file` and `bash`. `read_file` and `list_files` can read any path without asking, and the prompt shows only the path or command, not the file content or a diff.

## Repo layout

- [index.ts](index.ts), [claude.ts](claude.ts): the agent (one file per provider)
- [GLOSSARY.md](GLOSSARY.md): the project's vocabulary
- [playground/](playground/): scratch folder to run the agent in
- `.claude/skills/`: Claude Code dev-workflow skills used when working on this repo. They are not part of the agent and you can ignore them.
