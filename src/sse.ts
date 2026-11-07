import { Stream } from "effect"

// One server-sent event: the optional name from its `event:` line and the text of its `data:` lines.
export type Frame = { event?: string; data: string }

// The lines of the event being read so far.
type Pending = { event?: string; data: string[] }

const step = (pending: Pending, line: string): readonly [Pending, Frame[]] => {
  // A blank line ends the event. An event with no data lines is dropped.
  if (line === "") return [{ data: [] }, pending.data.length ? [{ event: pending.event, data: pending.data.join("\n") }] : []]

  // Every other line is `field: value`. A line that starts with a colon is a comment and has no field name.
  const colon = line.indexOf(":")
  if (colon <= 0) return [pending, []]
  const field = line.slice(0, colon)
  const value = line.slice(colon + 1).replace(/^ /, "")

  if (field === "data") return [{ ...pending, data: [...pending.data, value] }, []]
  if (field === "event") return [{ ...pending, event: value }, []]
  return [pending, []]
}

// Cuts bytes into events. The bytes can be split anywhere, even inside a line or inside a character.
export const frames = <E>(bytes: Stream.Stream<Uint8Array, E>): Stream.Stream<Frame, E> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapAccum((): Pending => ({ data: [] }), step),
  )