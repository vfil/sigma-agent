# sigma-agent

A small coding-agent in a handful of files, written to show how an LLM agent works. [Effect](https://effect.website) is the only dependency.

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
  └─► the protocol encodes the full history + tool definitions, and sends them to the provider
        the protocol decodes the reply into text and tool calls
        ├─ model replies with text         ─► print "Agent: ..."
        └─ model asks for tool call(s)     ─► for each one, print "[tool] name(args)", then:
              ├─ tool needs confirmation   ─► ask "Allow: ...? [y/N]"; anything but "y" declines
              ├─ run the tool              ─► result
              └─ tool failure             ─► print "[error] ...", and the error text becomes the result
            append the results, call the model again
      (repeat until the model answers without a tool call, then wait for your next prompt)
```

One prompt and everything the agent does in answer to it is a **turn**. Failures are typed errors (see [src/errors.ts](src/errors.ts)), and the loop handles each kind in one place:

- **Tool failures** (unknown tool, invalid arguments, a declined confirmation, a command timeout, a missing file) are sent back to the model as an error result, so it can read the message and try something else.
- **Provider errors** (server unreachable, a non-OK status, an unreadable reply) are printed as `[provider error] ...` for you only. The model never sees them.
- **Bugs** in the program are printed as `[bug] ...`.

After a provider error or a bug the whole turn is dropped from the history and the prompt returns, so the next prompt starts from a consistent conversation.

The loop never sees a wire format. The conversation is a `history` of protocol-neutral messages made of text, tool-call and tool-result parts, and the active **protocol** encodes it for the wire and decodes the reply. Two details differ by protocol:

- **OpenAI Chat Completions** has no error flag on tool results, so an error result is sent as text starting with `Error: `.
- **Anthropic Messages** marks failures with `is_error`, and the loop keeps the provider's own reply content (thinking blocks included) so it can send it back unchanged.

The whole conversation lives in memory (`history`) and is lost when the process exits.

## Adding a tool

A tool is built with `defineTool` and added to the `tools` array in [src/tools.ts](src/tools.ts):

```ts
defineTool({
  name: "word_count",
  description: "Count the words in a text file.",   // the model reads this to decide when to use it
  input: Schema.Struct({                            // one Schema: validates the input and becomes the JSON Schema the model receives
    path: Schema.String.annotate({ description: "Path of the file to count, e.g. 'notes.txt'" }),
  }),
  execute: async ({ path }) => String((await readFile(path, "utf8")).split(/\s+/).length), // receives the validated, typed input
  confirm: ({ path }) => `count words in ${path}`,  // optional: set it to require confirmation
})
```

`runTool` (in [src/tool.ts](src/tool.ts)) looks the tool up and runs it. The tool checks the input against its `Schema`, asks for confirmation when `confirm` is set, then runs `execute`. Bad input becomes an `InvalidInput` error result that lists each problem and the fields the tool takes, and anything `execute` throws becomes an error result, so the model can read it and fix its call.

## Providers

One agent loop, three **providers**. Pick one with the `PROVIDER` env var (default `ollama`):

| `PROVIDER`  | Talks to                       | Protocol                | Default base URL            | Default model       |
| ----------- | ------------------------------ | ----------------------- | --------------------------- | ------------------- |
| `ollama`    | Ollama                         | OpenAI Chat Completions | `http://127.0.0.1:11434/v1` | `qwen3.5:9b`        |
| `llamacpp`  | llama.cpp server               | OpenAI Chat Completions | `http://127.0.0.1:9931/v1`  | `qwen3.5:9b`        |
| `claude`    | Anthropic API                  | Anthropic Messages      | `https://api.anthropic.com` | `claude-sonnet-5-5` |

```bash
bun src/index.ts                               # Ollama
PROVIDER=llamacpp bun src/index.ts             # llama.cpp on :9931
PROVIDER=claude ANTHROPIC_API_KEY=... bun src/index.ts
```

Env vars:

- `PROVIDER`: `ollama`, `llamacpp` or `claude`. Any other value stops the program with the list of valid ones.
- `ANTHROPIC_API_KEY`: required when `PROVIDER=claude`, ignored otherwise.
- `BASE_URL`, `MODEL`: override the chosen provider's defaults, whichever provider it is. `ANTHROPIC_BASE_URL` is no longer read; use `BASE_URL` to point `claude` at another endpoint.

## Adding a provider

A **route** binds a **protocol** to one provider's endpoint, headers and model. A server that speaks an existing protocol needs only a new entry in `routes` in [src/provider.ts](src/provider.ts):

```ts
vllm: { protocol: openaiChat, baseUrl: "http://127.0.0.1:8000/v1", headers: {}, model: "my-model" },
```

A new wire format needs a new `Protocol` object in [src/protocols.ts](src/protocols.ts) with three members: `path` (the URL path to call), `body` (turns the history and tools into the request body) and `decode` (turns the response into a message and a finish reason: `tool-calls`, `stop` or `refusal`). Then reference it from a route.

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
   - **`ollama`** (default): start Ollama and pull the model (`ollama pull qwen3.5:9b`).
   - **`llamacpp`**: start your llama.cpp server on port `9931`.
   - **`claude`**: `export ANTHROPIC_API_KEY=...`
2. Start the agent from inside `playground/`:

   ```bash
   cd playground
   bun ../src/index.ts                      # Ollama
   PROVIDER=llamacpp bun ../src/index.ts    # llama.cpp
   PROVIDER=claude bun ../src/index.ts      # Claude
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

Press `Ctrl+C` to quit. Ending the input with `Ctrl+D` also exits cleanly.

## Known limitations

- No sandboxing, no streaming, no history persistence.
- A turn that fails with a provider error or a bug is dropped from the history, including any tool calls it already ran. If the model had already edited a file or run a command before the failure, that change stays on disk but the model no longer remembers making it.
- Confirmation covers only `edit_file`, `write_file` and `bash`. `read_file` and `list_files` can read any path without asking, and the prompt shows only the path or command, not the file content or a diff.

## Repo layout

- [src/index.ts](src/index.ts): the entry point: the history, the agent loop (one turn per prompt) and the top-level error handling
- [src/messages.ts](src/messages.ts): the protocol-neutral message types
- [src/tool.ts](src/tool.ts): `defineTool` and `runTool`
- [src/tools.ts](src/tools.ts): the five tools
- [src/protocols.ts](src/protocols.ts): the OpenAI Chat Completions and Anthropic Messages protocols
- [src/provider.ts](src/provider.ts): the routes, provider selection from env vars, and the model call
- [src/errors.ts](src/errors.ts): the typed errors
- [src/terminal.ts](src/terminal.ts): reading a line from the user
- [GLOSSARY.md](GLOSSARY.md): the project's vocabulary
- [playground/](playground/): scratch folder to run the agent in
- `.claude/skills/`: Claude Code dev-workflow skills used when working on this repo. They are not part of the agent and you can ignore them.
