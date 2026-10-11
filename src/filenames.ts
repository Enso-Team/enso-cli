import { EnsoCliError } from "./errors.js";

/** Validate a single filename component before an authoring mutation. */
export function validateFilename(value: string, path: string, suffix = ""): void {
  const rule = value.trim().length === 0 ? "a nonempty filename" :
    value === "." || value === ".." ? "a filename other than . or .." :
    /[\\/:\u0000-\u001f\u007f]/u.test(value) ? "a filename without separators, colons, or control characters" :
    Buffer.byteLength(value + suffix, "utf8") > 255 ? "a filename of at most 255 UTF-8 bytes including its extension" : undefined;
  if (rule) throw new EnsoCliError("invalid_filename", `Invalid ${path} '${value}': expected ${rule}`, {
    path, value, expected: rule, hint: "Use a descriptive filename such as WaveSpeed – Higgsfield APIs; use separate folder components for a relative path"
  });
}

/** A note selector names a title or a vault-relative path with safe components. */
export function validateNotePath(value: string, path: string): void {
  const parts = value.split("/");
  parts.forEach((part, index) => validateFilename(part, path, index === parts.length - 1 && !/\.md$/i.test(part) ? ".md" : ""));
}
