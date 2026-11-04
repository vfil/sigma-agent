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

**Confirmation**:
The step where the user must approve a gated tool call before it runs. Declining turns the call into an error result.
_Avoid_: Permission prompt, approval, allow prompt
