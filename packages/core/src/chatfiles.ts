// Files people attach to a chat message (roadmap 17g): images the leader looks at and small text files it reads.
// Browser-safe: the page checks a file with the same rules before uploading it; the hub checks it again.
import { HiveError } from "./errors.ts";

/** Per file, and per message. */
export const CHAT_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_FILES_PER_MESSAGE = 4;

/** What an attachment is, read from its bytes: images and PDF by their signature, text by its name and UTF-8 content. */
export type ChatFileType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf" | "text/plain" | "text/markdown" | "text/csv" | "application/json";

/** The text kinds, by extension. Anything else that is not an image or a PDF is refused. */
const TEXT_TYPES: Record<string, ChatFileType> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/** Accepted by the file picker (the hub checks the bytes anyway). */
export const CHAT_FILE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.log,.md,.markdown,.csv,.json";

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The file's kind from its first bytes, or for text its extension; null when it is none of the accepted kinds. */
export function sniffChatFile(name: string, bytes: Uint8Array): ChatFileType | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, ascii("GIF87a")) || starts(bytes, ascii("GIF89a"))) return "image/gif";
  if (starts(bytes, ascii("RIFF")) && starts(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (starts(bytes, ascii("%PDF-"))) return "application/pdf";
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const text = TEXT_TYPES[ext];
  if (!text) return null;
  // Text is UTF-8 and has no NUL: a binary file renamed .txt is refused.
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text;
}

export const isImage = (type: string): boolean => type.startsWith("image/");

/** A name safe to show and to write on a machine: no folders, no control or hidden characters, at most 120 characters. */
export function chatFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/^\.+/, "")
    .trim();
  const cut = clean.length > 120 ? clean.slice(clean.length - 120) : clean;
  return cut || "file";
}

/** Refuses what the hub will not keep, with the reason in the UI's words. */
export function checkChatFile(name: string, bytes: Uint8Array): ChatFileType {
  if (bytes.length === 0) throw new HiveError("bad_request", `${name} is empty.`, { key: "errors.chatFileEmpty", vars: { name } });
  if (bytes.length > CHAT_FILE_MAX_BYTES) {
    throw new HiveError("bad_request", `${name} is over ${CHAT_FILE_MAX_BYTES / 1024 / 1024} MB.`, {
      key: "errors.chatFileTooBig",
      vars: { name, mb: CHAT_FILE_MAX_BYTES / 1024 / 1024 },
    });
  }
  const type = sniffChatFile(name, bytes);
  if (!type) throw new HiveError("bad_request", `${name}: only images, PDF and text files.`, { key: "errors.chatFileType", vars: { name } });
  return type;
}
