import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { type RequestContext, withTenant } from "../platform/index.ts";
import { defaultProviderFactory } from "../scm/index.ts";
import { allowWith, type OrgDeps, orgMiddlewares, requireOrgRole } from "../tenancy/index.ts";
import type { Principal } from "./access.ts";
import { docHistory, getDoc, listDocs, saveDoc } from "./docs.ts";
import { embedQuery, type KnowledgeDeps, listMemories, searchMemory, supersedeMemory, writeMemory } from "./memory.ts";
import { approveProposal, createProposal, listProposals, rejectProposal } from "./proposals.ts";
import {
  afterSkillChange,
  getSkillRepo,
  removeSkillRepo,
  requestSkillSync,
  type SkillRepoDeps,
  setSkillRepo,
} from "./skill-repo.ts";
import { getSkill, listSkills, saveSkill } from "./skills.ts";

const asUser = (user: { id: string }): Principal => ({ kind: "user", userId: user.id });

export function knowledgeRouter(
  deps: KnowledgeDeps & OrgDeps & Partial<Pick<SkillRepoDeps, "masterKey" | "providerFactory" | "publicUrl">>,
) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const skillRepo = implement(contract.skillRepo).$context<RequestContext>().use(authed);
  const repoDeps = {
    masterKey: deps.masterKey,
    providerFactory: deps.providerFactory ?? defaultProviderFactory,
    publicUrl: deps.publicUrl,
    jobs: deps.jobs,
  };
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
      // Có kho skill Git thì bản vừa lưu được đẩy lên Git trong lần đồng bộ kế tiếp (xếp cùng transaction).
      save: skills.save.handler(async ({ context: { tx, user, orgId }, input }) => {
        const saved = await saveSkill(tx, asUser(user), input);
        await afterSkillChange(tx, deps, { kind: "sync", orgId });
        return saved;
      }),
    },
    proposals: {
      create: proposals.create.handler(async ({ context: { tx, user, orgId }, input }) => {
        const p = await createProposal(tx, asUser(user), input);
        if (p.kind === "skill") await afterSkillChange(tx, deps, { kind: "open-pr", orgId, proposalId: p.id });
        return p;
      }),
      list: proposals.list.handler(({ context: { tx, user }, input }) => listProposals(tx, asUser(user), input)),
      approve: proposals.approve.handler(async ({ context: { tx, user, orgId }, input }) => {
        const p = await approveProposal(tx, asUser(user), input);
        if (p.kind === "skill") {
          await afterSkillChange(tx, deps, { kind: "close-pr", orgId, proposalId: p.id });
          await afterSkillChange(tx, deps, { kind: "sync", orgId });
        }
        return p;
      }),
      reject: proposals.reject.handler(async ({ context: { tx, user, orgId }, input }) => {
        const p = await rejectProposal(tx, asUser(user), input);
        if (p.kind === "skill") await afterSkillChange(tx, deps, { kind: "close-pr", orgId, proposalId: p.id });
        return p;
      }),
    },
    skillRepo: {
      get: skillRepo.get.use(inOrg).handler(({ context: { tx } }) => getSkillRepo(tx)),
      set: skillRepo.set.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
        await withTenant(pool, { userId: user.id, orgId }, (tx) => requireOrgRole(tx, user.id, "admin"));
        return setSkillRepo({ ...repoDeps, pool }, { userId: user.id, orgId }, input);
      }),
      remove: skillRepo.remove.use(orgMember).handler(async ({ context: { pool, user, orgId } }) => {
        await withTenant(pool, { userId: user.id, orgId }, (tx) => requireOrgRole(tx, user.id, "admin"));
        return removeSkillRepo({ ...repoDeps, pool }, { userId: user.id, orgId });
      }),
      // Quản trị tổ chức, hoặc vai trò tự tạo có skills.write.
      sync: skillRepo.sync.use(inOrg).handler(async ({ context: { tx, user, orgId } }) => {
        await allowWith(tx, user.id, "skills.write", () => requireOrgRole(tx, user.id, "admin"));
        return requestSkillSync(tx, deps, orgId);
      }),
    },
  };
}
