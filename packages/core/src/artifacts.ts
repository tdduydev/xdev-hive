// What an agent makes while it works (roadmap 41c): smoke screenshots, reports, measurements, a plan. They used to
// live only in the worktree or the branch on the machine that ran, so deleting either lost them. The agent writes
// them in ARTIFACT_DIR of its worktree, the runner sends them to the hub when the run ends, and the hub keeps them
// beside the run and the task. Browser-safe: the web checks a file with the same rules the hub does.
import { sniffChatFile } from "./chatfiles.ts";
import { DOC_ASSET_MAX_BYTES } from "./doclinks.ts";
import { HiveError } from "./errors.ts";
import { stripHidden } from "./hidden.ts";
import type { WriteSource } from "./source.ts";

/** Where an agent puts what it made, inside its worktree. Out of the commit, like the context of roadmap 38a. */
export const ARTIFACT_DIR = ".xdev-hive/artifacts";
/** Per run. What is over stays on the machine, with a line in the run's log saying so. */
export const ARTIFACTS_PER_RUN = 20;
/** Per file, the same as a file attached to a doc. */
export const ARTIFACT_MAX_BYTES = DOC_ASSET_MAX_BYTES;
/** How deep under ARTIFACT_DIR the runner looks (a folder of screenshots, not a whole build output). */
export const ARTIFACT_DEPTH = 3;

/**
 * Only these kinds. Text the hub can read, hide secrets in and keep hidden characters out of; images and PDF a
 * person looks at. GIF and CSV, which an attachment may be, are not among them: 41c lists png, jpg, webp and pdf
 * for bytes nobody can read, and md, txt, json and log for text.
 */
export const ARTIFACT_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain", "text/markdown", "application/json"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Its bytes are text: they go through redactLines and are refused when they hide characters. */
export const isArtifactText = (type: string): boolean => type.startsWith("text/") || type === "application/json";

/** What the hub keeps about one file; `source` says which machine, run and task made it (roadmap 2b). */
export interface Artifact {
  id: number;
  project: string;
  taskId: string;
  runId: string;
  /** The machine that sent it: with runId, which run it belongs to. */
  machineId: string;
  /** Relative to ARTIFACT_DIR, e.g. "shots/board.png". */
  name: string;
  type: string;
  size: number;
  sha256: string;
  /** The agent profile that made it, when the machine said which. */
  profileId: string | null;
  uploadedBy: string;
  source: WriteSource | null;
  createdAt: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A path under ARTIFACT_DIR as a name safe to keep and to show: forward slashes, no folder tricks ("..", a leading
 * "/" or "."), no control or hidden characters, at most 200 characters. "" for a path that is nothing but those.
 */
export function artifactName(rel: string): string {
  const parts = rel
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => stripHidden(p.normalize("NFC").replace(CONTROL, "")).replace(/^\.+/, "").trim())
    .filter(Boolean);
  const name = parts.join("/");
  return name.length > 200 ? name.slice(name.length - 200) : name;
}

/** Refuses an empty file or one over the limit from its size alone, so the runner need not read a huge one first. */
export function checkArtifactSize(name: string, size: number): void {
  if (size === 0) throw new HiveError("bad_request", `${name} is empty.`, { key: "errors.chatFileEmpty", vars: { name } });
  if (size > ARTIFACT_MAX_BYTES) {
    throw new HiveError("bad_request", `${name} is over ${ARTIFACT_MAX_BYTES / 1024 / 1024} MB.`, {
      key: "errors.chatFileTooBig",
      vars: { name, mb: ARTIFACT_MAX_BYTES / 1024 / 1024 },
    });
  }
}

/** Refuses what the hub will not keep, in the words the interface shows. */
export function checkArtifact(name: string, bytes: Uint8Array): ArtifactType {
  checkArtifactSize(name, bytes.length);
  const type = sniffChatFile(name, bytes);
  if (!type || !(ARTIFACT_TYPES as readonly string[]).includes(type)) {
    throw new HiveError("bad_request", `${name}: an artifact is a png, jpg, webp or pdf, or text as md, txt, json or log.`, { key: "errors.artifactType", vars: { name } });
  }
  return type as ArtifactType;
}
