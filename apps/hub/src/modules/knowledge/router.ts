import { implement } from "@orpc/server";
import { type AssistStartInput, type AssistTarget, contract, type DocAssist } from "@xdev-hive/contracts";
import { ConflictError, type RequestContext, type Tx, withTenant } from "../platform/index.ts";
import { defaultProviderFactory } from "../scm/index.ts";
import { allowWith, type OrgDeps, orgMiddlewares, requireOrgRole } from "../tenancy/index.ts";
import type { Principal } from "./access.ts";
import { briefView, getBrief, saveBrief } from "./brief.ts";
import { docHistory, getDoc, listDocs, saveDoc } from "./docs.ts";
import {
  addComment,
  createSnapshot,
  createSuggestion,
  decideSuggestion,
  editorState,
  getSnapshot,
  listSnapshots,
  listSuggestions,
  listThreads,
  previewSubmit,
  rebaseDraft,
  resolveThread,
  saveDraft,
  submitDraft,
} from "./editor.ts";
import {
  approveMemory,
  embedQuery,
  type KnowledgeDeps,
  listMemories,
  rejectMemory,
  searchMemory,
  supersedeMemory,
  writeMemory,
} from "./memory.ts";
import { approveProposal, listProposals, rejectProposal } from "./proposals.ts";
import {
  decideReview,
  dryRunWorkflow,
  getReview,
  listReviews,
  listWorkflows,
  proposeWithReview,
  removeWorkflow,
  saveWorkflow,
} from "./reviews.ts";
import { getPackSkill, listSkillPack, packSkillFiles, setSkillPack } from "./skill-pack.ts";
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

/** Trợ lý AI của trình soạn tài liệu, do module runs cài vào (knowledge không import runs). */
export interface DocAssistPort {
  targets(tx: Tx, userId: string): Promise<AssistTarget[]>;
  list(tx: Tx, userId: string, key: string): Promise<DocAssist[]>;
  start(tx: Tx, userId: string, input: AssistStartInput): Promise<{ assist: DocAssist; afterCommit: () => void }>;
}

/** Run viết lại brief, do module runs cài vào như DocAssistPort. */
export interface BriefPort {
  /** Run brief đang chờ hoặc đang chạy của dự án. */
  activeRun(tx: Tx, projectId: string): Promise<string | null>;
  refresh(tx: Tx, userId: string, project: string): Promise<{ runId: string; afterCommit: () => void }>;
}

export function knowledgeRouter(
  deps: KnowledgeDeps &
    OrgDeps &
    Partial<Pick<SkillRepoDeps, "masterKey" | "providerFactory" | "publicUrl">> & {
      docAssist?: DocAssistPort | undefined;
      briefs?: BriefPort | undefined;
    },
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
  const briefs = implement(contract.briefs).$context<RequestContext>().use(authed);
  const docs = implement(contract.docs).$context<RequestContext>().use(authed).use(inOrg);
  const skills = implement(contract.skills).$context<RequestContext>().use(authed).use(inOrg);
  const proposals = implement(contract.proposals).$context<RequestContext>().use(authed).use(inOrg);
  const workflows = implement(contract.reviewWorkflows).$context<RequestContext>().use(authed).use(inOrg);
  const reviews = implement(contract.reviews).$context<RequestContext>().use(authed).use(inOrg);
  const reviewDeps = { jobs: deps.jobs, publicUrl: deps.publicUrl };
  const editor = implement(contract.docEditor).$context<RequestContext>().use(authed);
  const assist = () => {
    if (!deps.docAssist)
      throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình HIVE_AUTH_SECRET nên chưa chạy được trợ lý AI.");
    return deps.docAssist;
  };
  const briefPort = () => {
    if (!deps.briefs)
      throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình HIVE_AUTH_SECRET nên chưa chạy được run viết brief.");
    return deps.briefs;
  };
  return {
    briefs: {
      get: briefs.get.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
        const row = await getBrief(tx, asUser(user), input.project);
        return row ? briefView(row, (await deps.briefs?.activeRun(tx, row.projectId)) ?? null) : null;
      }),
      save: briefs.save.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
        const row = await saveBrief(tx, asUser(user), input);
        return briefView(row, (await deps.briefs?.activeRun(tx, row.projectId)) ?? null);
      }),
      // Tự mở transaction để giao run tới máy sau khi commit, như runs.start.
      refresh: briefs.refresh.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
        const port = briefPort();
        const { runId, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
          port.refresh(tx, user.id, input.project),
        );
        afterCommit();
        return { runId };
      }),
    },
    docEditor: {
      state: editor.state
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => editorState(tx, asUser(user), input)),
      save: editor.save.use(inOrg).handler(({ context: { tx, user }, input }) => saveDraft(tx, asUser(user), input)),
      rebase: editor.rebase
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => rebaseDraft(tx, asUser(user), input)),
      submitPreview: editor.submitPreview
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => previewSubmit(tx, asUser(user), input)),
      submit: editor.submit
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => submitDraft(tx, asUser(user), input, reviewDeps)),
      suggestions: {
        list: editor.suggestions.list
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => listSuggestions(tx, asUser(user), input)),
        create: editor.suggestions.create
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => createSuggestion(tx, asUser(user), input)),
        decide: editor.suggestions.decide
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => decideSuggestion(tx, asUser(user), input)),
      },
      comments: {
        list: editor.comments.list
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => listThreads(tx, asUser(user), input)),
        add: editor.comments.add
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => addComment(tx, asUser(user), input)),
        resolve: editor.comments.resolve
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => resolveThread(tx, asUser(user), input)),
      },
      snapshots: {
        list: editor.snapshots.list
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => listSnapshots(tx, asUser(user), input)),
        get: editor.snapshots.get
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => getSnapshot(tx, asUser(user), input)),
        create: editor.snapshots.create
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => createSnapshot(tx, asUser(user), input)),
      },
      assist: {
        targets: editor.assist.targets.use(inOrg).handler(({ context: { tx, user } }) => assist().targets(tx, user.id)),
        list: editor.assist.list
          .use(inOrg)
          .handler(({ context: { tx, user }, input }) => assist().list(tx, user.id, input.key)),
        // Tự mở transaction để giao run tới máy sau khi commit, như runs.start.
        start: editor.assist.start.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
          const port = assist();
          const { assist: out, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
            port.start(tx, user.id, input),
          );
          afterCommit();
          return out;
        }),
      },
    },
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
      approve: memory.approve
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => approveMemory(tx, asUser(user), input.id, deps)),
      reject: memory.reject.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
        await rejectMemory(tx, asUser(user), input.id);
        return { ok: true as const };
      }),
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
      pack: skills.pack.handler(({ context: { tx, user }, input }) => listSkillPack(tx, asUser(user), input)),
      packGet: skills.packGet.handler(({ context: { tx, user }, input }) => getPackSkill(tx, asUser(user), input)),
      packFiles: skills.packFiles.handler(({ context: { tx, user }, input }) =>
        packSkillFiles(tx, asUser(user), input),
      ),
      packSet: skills.packSet.handler(({ context: { tx, user }, input }) => setSkillPack(tx, asUser(user), input)),
    },
    proposals: {
      create: proposals.create.handler(async ({ context: { tx, user, orgId }, input }) => {
        const p = await proposeWithReview(tx, asUser(user), input, reviewDeps);
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
    reviewWorkflows: {
      list: workflows.list.handler(({ context: { tx, user }, input }) =>
        listWorkflows(tx, asUser(user), input?.subject),
      ),
      save: workflows.save.handler(({ context: { tx, user }, input }) => saveWorkflow(tx, user.id, input)),
      remove: workflows.remove.handler(async ({ context: { tx, user }, input }) => {
        await removeWorkflow(tx, user.id, input.id);
        return { ok: true as const };
      }),
      dryRun: workflows.dryRun.handler(({ context: { tx, user }, input }) => dryRunWorkflow(tx, asUser(user), input)),
    },
    reviews: {
      list: reviews.list.handler(({ context: { tx, user }, input }) => listReviews(tx, user.id, input)),
      get: reviews.get.handler(({ context: { tx, user }, input }) => getReview(tx, user.id, input.id)),
      decide: reviews.decide.handler(({ context: { tx, user }, input }) =>
        decideReview(tx, user.id, input, reviewDeps),
      ),
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
