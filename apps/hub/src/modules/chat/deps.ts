import type pg from "pg";
import type { DecideDeps } from "../codereview/index.ts";
import type { Jobs, MasterKey } from "../platform/index.ts";
import type { RunsEngine } from "../runs/index.ts";
import type { ChatApiDeps } from "./adapters.ts";

export interface ChatDeps extends ChatApiDeps {
  pool: pg.Pool;
  masterKey?: MasterKey | undefined;
  /** Không có thì xem được trạng thái nhưng không huỷ run, không gửi Leader được (thiếu HIVE_AUTH_SECRET). */
  runs?: RunsEngine | undefined;
  jobs?: Jobs | undefined;
  /** Địa chỉ web của hub, để nút "Mở trên web". */
  publicUrl: string;
  codeReviews?: DecideDeps | undefined;
}
