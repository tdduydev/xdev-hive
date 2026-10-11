import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import type { Auth } from "./auth.ts";

export function meRouter(auth: Auth | undefined) {
  const os = implement(contract.me).$context<RequestContext>();
  return {
    get: os.get.handler(async ({ context, errors }) => {
      const session = auth ? await auth.api.getSession({ headers: context.headers }) : null;
      if (!session) throw errors.UNAUTHORIZED();
      const { id, name, email, image } = session.user;
      return { id, name, email, image: image ?? null };
    }),
  };
}
