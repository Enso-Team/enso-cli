import { EnsoError } from "./errors.js";

export function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Validate a single filename component before an authoring mutation. */
export function validateFilename(value: string, path: string, suffix = ""): void {
  const rule = value.trim().length === 0 ? "a nonempty filename" :
    value === "." || value === ".." ? "a filename other than . or .." :
    /[\\/:\u0000-\u001f\u007f]/u.test(value) ? "a filename without separators, colons, or control characters" :
    utf8Length(value + suffix) > 255 ? "a filename of at most 255 UTF-8 bytes including its extension" : undefined;
  if (rule) throw new EnsoError("invalid_filename", `Invalid ${path} '${value}': expected ${rule}`, {
    path, value, expected: rule, hint: "Use a descriptive filename such as WaveSpeed – Higgsfield APIs; use separate folder components for a relative path"
  });
}

/** A note selector names a title or a vault-relative path with safe components. */
export function validateNotePath(value: string, path: string): void {
  const parts = value.split("/");
  parts.forEach((part, index) => validateFilename(part, path, index === parts.length - 1 && !/\.md$/i.test(part) ? ".md" : ""));
}
