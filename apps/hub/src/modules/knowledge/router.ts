import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import type { Principal } from "./access.ts";
import { docHistory, getDoc, listDocs, saveDoc } from "./docs.ts";
import { embedQuery, type KnowledgeDeps, listMemories, searchMemory, supersedeMemory, writeMemory } from "./memory.ts";
import { approveProposal, createProposal, listProposals, rejectProposal } from "./proposals.ts";
import { getSkill, listSkills, saveSkill } from "./skills.ts";

const asUser = (user: { id: string }): Principal => ({ kind: "user", userId: user.id });

export function knowledgeRouter(deps: KnowledgeDeps & OrgDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const memory = implement(contract.memory).$context<RequestContext>().use(authed);
  const docs = implement(contract.docs).$context<RequestContext>().use(authed).use(inOrg);
  const skills = implement(contract.skills).$context<RequestContext>().use(authed).use(inOrg);
  const proposals = implement(contract.proposals).$context<RequestContext>().use(authed).use(inOrg);
  return {
    memory: {
      write: memory.write
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => writeMemory(tx, asUser(user), input, deps)),
      // Gọi API embeddings trước, ngoài transaction (orgMember), để không giữ kết nối database trong lúc chờ mạng.
      search: memory.search.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
        const queryEmbedding = await embedQuery(deps.embedder, input.query);
        return withTenant(pool, { userId: user.id, orgId }, (tx) =>
          searchMemory(tx, asUser(user), input, { ...deps, queryEmbedding }),
        );
      }),
      list: memory.list.use(inOrg).handler(({ context: { tx, user }, input }) => listMemories(tx, asUser(user), input)),
      supersede: memory.supersede
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => supersedeMemory(tx, asUser(user), input, deps)),
    },
    docs: {
      list: docs.list.handler(({ context: { tx, user }, input }) => listDocs(tx, asUser(user), input)),
      get: docs.get.handler(({ context: { tx, user }, input }) => getDoc(tx, asUser(user), input)),
      save: docs.save.handler(({ context: { tx, user }, input }) => saveDoc(tx, asUser(user), input)),
      history: docs.history.handler(({ context: { tx, user }, input }) => docHistory(tx, asUser(user), input)),
    },
    skills: {
      list: skills.list.handler(({ context: { tx, user }, input }) => listSkills(tx, asUser(user), input)),
      get: skills.get.handler(({ context: { tx, user }, input }) => getSkill(tx, asUser(user), input)),
      save: skills.save.handler(({ context: { tx, user }, input }) => saveSkill(tx, asUser(user), input)),
    },
    proposals: {
      create: proposals.create.handler(({ context: { tx, user }, input }) => createProposal(tx, asUser(user), input)),
      list: proposals.list.handler(({ context: { tx, user }, input }) => listProposals(tx, asUser(user), input)),
      approve: proposals.approve.handler(({ context: { tx, user }, input }) =>
        approveProposal(tx, asUser(user), input),
      ),
      reject: proposals.reject.handler(({ context: { tx, user }, input }) => rejectProposal(tx, asUser(user), input)),
    },
  };
}
