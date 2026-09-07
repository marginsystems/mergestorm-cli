const TOOL_PAYLOAD_KEYS = new Set([
  "function_call",
  "tool",
  "tool_call",
  "tool_calls",
]);

function parseJsonContainer(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function looksLikeToolPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(looksLikeToolPayload);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => TOOL_PAYLOAD_KEYS.has(key.toLowerCase()))) return true;
  const lower = new Set(keys.map((key) => key.toLowerCase()));
  if (record.type === "tool_use" && lower.has("name") && lower.has("input")) return true;
  if (lower.has("verdict") && lower.has("comments")) return true;
  return Object.values(record).some(looksLikeToolPayload);
}

function matchingJsonEnd(text: string, start: number): number | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const stack = [open];
  let quoted = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return null;
      if (stack.length === 0) return i + 1;
    }
  }
  return null;
}

function fencedLines(text: string): Set<number> {
  const lines = text.split("\n");
  const protectedLines = new Set<number>();
  const openFences: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```[a-z0-9_-]+\s*$/i.test(lines[i]!)) {
      openFences.push(i);
    } else if (/^\s*```\s*$/.test(lines[i]!)) {
      if (openFences.length > 0) {
        const start = openFences.pop()!;
        for (let line = start; line <= i; line += 1) protectedLines.add(line);
      } else {
        openFences.push(i);
      }
    }
  }
  return protectedLines;
}

function stripBoundaryPayload(text: string): string {
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    const protectedLines = fencedLines(result);
    for (let start = 0; start < result.length; start += 1) {
      if (result[start] !== "{" && result[start] !== "[") continue;
      if (protectedLines.has(result.slice(0, start).split("\n").length - 1)) continue;
      const end = matchingJsonEnd(result, start);
      if (end == null) continue;
      const parsed = parseJsonContainer(result.slice(start, end));
      if (
        parsed !== undefined &&
        looksLikeToolPayload(parsed)
      ) {
        const before = result.slice(0, start);
        const after = result.slice(end);
        result = `${before}${before.endsWith("\n") && after.startsWith("\n") ? after.slice(1) : after}`;
        changed = true;
        break;
      }
    }
  }
  return result;
}

function stripOrphanLines(text: string): string {
  const lines = text.split("\n");
  const keptLines = new Set<number>();
  const protectedLines = fencedLines(text);
  for (const line of protectedLines) keptLines.add(line);

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const end = matchingJsonEnd(text, start);
    if (end == null || parseJsonContainer(text.slice(start, end)) === undefined) continue;
    const i = text.slice(0, start).split("\n").length - 1;
    const lastLine = text.slice(0, end).split("\n").length - 1;
    for (let line = i; line <= lastLine; line += 1) {
      keptLines.add(line);
      if (i !== lastLine) protectedLines.add(line);
    }
  }

  return lines
    .filter(
      (line, i) =>
        protectedLines.has(i) ||
        (parseJsonContainer(line) === undefined &&
          (keptLines.has(i) || !/^\s*(?:```|[{}])\s*$/.test(line))),
    )
    .join("\n");
}

/** Remove tool/LLM JSON that is unsafe to show in human summary output. */
export function humanSummary(summary: string): string | null {
  let result = summary.replace(/\r\n?/g, "\n");

  result = result.replace(
    /```json[ \t]*\n([\s\S]*?)```/gi,
    (block, body: string) => parseJsonContainer(body) === undefined ? block : "",
  );

  result = stripBoundaryPayload(result);

  result = stripOrphanLines(result)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return result || null;
}
