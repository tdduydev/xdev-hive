import { compareVersions, type SetupItem } from "@xdev-hive/core";

/** An agent CLI behind the newest on its registry (roadmap 33); it still runs, so its state stays "installed". */
export const hasNewer = (i: Pick<SetupItem, "version" | "latest">): boolean => !!i.version && !!i.latest && compareVersions(i.latest, i.version) > 0;
