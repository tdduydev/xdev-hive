import { HiveError, type Actor, type HiveBackend } from "@xdev-hive/core";

export async function pendingProposalCount(backend: HiveBackend, actor: Actor): Promise<number> {
  try {
    return (await backend.call("proposals.count", { status: "pending" }, actor)).count;
  } catch (err) {
    if (!(err instanceof HiveError) || err.code !== "bad_request" || !/unknown method/i.test(err.message)) throw err;
    return (await backend.call("proposals.list", { status: "pending" }, actor)).length;
  }
}
