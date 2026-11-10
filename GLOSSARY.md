# sigma-agent

A minimal terminal coding agent: a person chats with a model, and the model acts on the machine only through tools.

## Language

**Tool**:
A named action the model may ask the program to perform, such as reading a file or running a command.
_Avoid_: Function, command, capability

**Tool call**:
One request from the model to run a specific tool with specific arguments.
_Avoid_: Function call, invocation

**Tool result**:
What the program sends back to the model after a tool call, either the tool's output or an error message the model can read.
_Avoid_: Response, tool output

**Tool failure**:
A tool call that did not succeed, reported to the model as an error result so it can try something else.
_Avoid_: Exception

**Confirmation**:
The step where the user must approve a gated tool call before it runs. Declining turns the call into an error result.
_Avoid_: Permission prompt, approval, allow prompt

## Talking to a model

**Provider**:
A model service the agent talks to, such as Ollama, llama.cpp or Claude.
_Avoid_: Backend, vendor, model server

**Protocol**:
The wire format a provider speaks, which the agent translates its own conversation to and from.
_Avoid_: API, format, adapter

**Route**:
A provider's endpoint, authentication and default model, bound to the protocol it speaks.
_Avoid_: Config, endpoint

**Provider error**:
A failed request to the model, reported only to the user and never shown to the model.
_Avoid_: API error

**Turn**:
One user prompt and everything the agent does in answer to it, from the first model call until the model replies without asking for a tool.
_Avoid_: Step, iteration, request

**History**:
The ordered conversation the agent sends to the model on every call, rebuilt from the session's events and leaving out any failed turn.
_Avoid_: Messages, context, transcript

## Sessions

**Session**:
A named conversation that survives restarts. It is identified by a session id, and starting the agent with the same id continues it.
_Avoid_: Chat, conversation, save file

**Session event**:
One recorded fact in a session: a prompt, a finished step, a tool result or a failed turn. Always written in full, never just "event", which would be confused with a model event.
_Avoid_: Event log, log entry, record

**Model event**:
One piece of a model's streamed reply: a piece of text, a finished tool call, or the finish of the reply. It is not recorded in the session; only the finished message is.
_Avoid_: Chunk, delta, stream event

**Resume**:
On startup, finishing a turn that a previous run left unfinished.
_Avoid_: Recover, replay, restore

**Interrupted tool call**:
A tool call that has no recorded result when a session resumes. It is never run again: it gets an error result saying it may or may not have run.
_Avoid_: Pending call, orphaned call
