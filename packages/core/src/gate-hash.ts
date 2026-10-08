// The template hash of spec 69h1 §3, apart from gate.ts because it needs node:crypto.
import { createHash } from "node:crypto";
import { canonicalJson, gateManifest, type GateManifest, type GateTemplate } from "./gate.ts";

export function gateManifestHash(manifest: GateManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export const gateTemplateHash = (t: GateTemplate): string => gateManifestHash(gateManifest(t));
