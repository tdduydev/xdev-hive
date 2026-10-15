import type pg from "pg";
import type { Jobs, MasterKey } from "../../platform/index.ts";
import type { ProviderFactory } from "../../scm/index.ts";

export interface DocSyncDeps {
  pool?: pg.Pool | undefined;
  jobs?: Jobs | undefined;
  masterKey?: MasterKey | undefined;
  providerFactory?: ProviderFactory | undefined;
  publicUrl?: string | undefined;
}
