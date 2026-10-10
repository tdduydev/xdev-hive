// What image the hub runs (UI-hub-build-info): the Hub page, the web's status bar and /api/health show it.
import { readFileSync } from "node:fs";
import type { HubBuild } from "@xdev-hive/core";

/** The version the repo is at: the desktop app's, which every roadmap item bumps. */
export function repoVersion(): string {
  try {
    const file = new URL("../../desktop/package.json", import.meta.url);
    return String((JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? "?");
  } catch {
    return "?";
  }
}

const clean = (v: string | undefined) => (v?.trim() ? v.trim() : null);

/**
 * HIVE_BUILD_* come from the image (Dockerfile ARG → ENV) and nothing sets them at run time. HIVE_COMMIT is also set by
 * compose (`${HIVE_COMMIT:-}`), often to "", which replaces the image's own value: HIVE_BUILD_COMMIT keeps that one.
 * A build without the args (docker build, compose build, npm run dev) yields nulls, and the UI says "dev build".
 */
export function buildInfo(env: Record<string, string | undefined>, version = repoVersion()): HubBuild {
  const date = clean(env.HIVE_BUILD_DATE);
  // A label someone typed by hand is not a date: better unknown than "Invalid Date" on the page.
  const buildDate = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null;
  return {
    version,
    commit: clean(env.HIVE_COMMIT) ?? clean(env.HIVE_BUILD_COMMIT),
    buildVersion: clean(env.HIVE_BUILD_VERSION),
    buildDate,
  };
}
