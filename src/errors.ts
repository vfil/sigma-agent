import { Schema } from "effect"

// Tool failures: each one becomes a tool result the model can read and react to.
export class UnknownTool extends Schema.TaggedError<UnknownTool>()("UnknownTool", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Unknown tool: ${this.name}. Available tools: ${this.available.join(", ")}`
  }
}

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  tool: Schema.String,
  problems: Schema.Array(Schema.String),
  takes: Schema.String,
}) {
  override get message() {
    return [`Invalid input for ${this.tool}:`, ...this.problems.map((problem) => `- ${problem}`), `${this.tool} takes an object with the fields: ${this.takes}`].join("\n")
  }
}

export class Declined extends Schema.TaggedError<Declined>()("Declined", {}) {
  override get message() {
    return "User declined this action. Ask what they would like instead."
  }
}

export class ToolCrashed extends Schema.TaggedError<ToolCrashed>()("ToolCrashed", {
  tool: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

// Failures of the model request. The user reads these; the model never sees them.
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

// The environment asks for a provider the agent cannot reach, such as an unknown PROVIDER or a missing API key.
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

// Standard input ended, so there is nobody left to ask.
export class InputClosed extends Schema.TaggedError<InputClosed>()("InputClosed", {}) {}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))