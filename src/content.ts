import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Turn shell/agent escape sequences into real characters before JSON encoding.
 * Shell double quotes pass `\n` as two characters; JSON bodies need U+000A.
 */
export function unescapeAgentText(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "n") {
        result += "\n";
        i++;
        continue;
      }
      if (next === "t") {
        result += "\t";
        i++;
        continue;
      }
      if (next === "r") {
        result += "\r";
        i++;
        continue;
      }
      if (next === "\\") {
        result += "\\";
        i++;
        continue;
      }
    }
    result += text[i];
  }
  return result;
}

export function readContentValue(value: string): string {
  if (value.startsWith("@")) {
    return readFileSync(resolve(value.slice(1)), "utf8");
  }
  return unescapeAgentText(value);
}
