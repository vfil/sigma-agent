import { Context, Effect, Schema, SchemaIssue } from "effect"
import { Declined, InvalidInput, messageOf, ToolCrashed, UnknownTool } from "./errors"
import type { ToolCallPart, ToolResultPart, ToolResultValue } from "./messages"
import { Terminal } from "./terminal"

export type ToolFailure = UnknownTool | InvalidInput | Declined | ToolCrashed

export type Tool = {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema, derived from the input Schema
  run: (input: unknown) => Effect.Effect<string, ToolFailure, Terminal>
}

// The tools the agent knows, as a service. Which tools exist is decided where the layer is built.
export class Tools extends Context.Service<Tools, Tool[]>()("@agent/Tools") {}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

// Builds a Tool from one Schema: it validates the input and produces the JSON Schema the model receives.
// `DecodingServices: never` limits S to Schemas that need nothing else to decode, so `run` keeps R = never.
export const defineTool = <S extends Schema.Struct<Schema.Struct.Fields> & { readonly DecodingServices: never }>(config: {
  name: string
  description: string
  input: S
  execute: (input: S["Type"]) => Promise<string>
  confirm?: (input: S["Type"]) => string // describes the action; when set, the user must approve it first
}): Tool => {
  const takes = Object.keys(config.input.fields).join(", ")
  const decode = Schema.decodeUnknownEffect(config.input)

  return {
    name: config.name,
    description: config.description,
    parameters: Schema.toJsonSchemaDocument(config.input).schema,
    run: (raw) =>
      Effect.gen(function* () {
        // A string is arguments that were not valid JSON; the protocol keeps the raw text.
        if (typeof raw === "string") {
          return yield* new InvalidInput({ tool: config.name, problems: [`the arguments are not valid JSON: ${raw}`], takes })
        }

        const input = yield* decode(raw, { errors: "all" }).pipe(
          Effect.mapError(
            (error) =>
              new InvalidInput({
                tool: config.name,
                problems: formatIssues(error.issue).issues.map((issue) => `${issue.path?.join(".") || "input"}: ${issue.message}`),
                takes,
              }),
          ),
        )

        if (config.confirm) {
          // No answer counts as "no".
          const terminal = yield* Terminal
          const answer = yield* terminal.ask(`Allow: ${config.confirm(input)}? [y/N] `).pipe(Effect.orElseSucceed(() => ""))
          if (answer.trim().toLowerCase() !== "y") return yield* new Declined()
        }

        return yield* Effect.tryPromise({
          try: () => config.execute(input),
          catch: (error) => new ToolCrashed({ tool: config.name, reason: messageOf(error) }),
        })
      }),
  }
}

// Cannot fail: every tool failure becomes a tool result the model can read.
export const runTool = (call: ToolCallPart): Effect.Effect<ToolResultPart, never, Tools | Terminal> =>
  Effect.gen(function* () {
    const tools = yield* Tools
    const done = (result: ToolResultValue): ToolResultPart => ({ type: "tool-result", id: call.id, name: call.name, result })
    const tool = tools.find((tool) => tool.name === call.name)
    const run = tool ? tool.run(call.input) : Effect.fail(new UnknownTool({ name: call.name, available: tools.map((tool) => tool.name) }))

    return yield* run.pipe(
      Effect.map((value) => done({ type: "text", value })),
      Effect.catch((failure) => Effect.succeed(done({ type: "error", value: failure.message }))),
    )
  })