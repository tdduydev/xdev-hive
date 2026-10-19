// Tri thức dùng chung cho agent: memory, tài liệu, skill, đề xuất sửa. Module khác chỉ import file này.
// Các hàm nhận (tx, principal, input) là API public để cổng MCP gắn tool vào: tx là transaction withTenant của tổ
// chức, principal là người dùng hoặc run đã được xác thực.
export {
  type Action as DocAction,
  authorize,
  type DocAccessFor,
  type DocAccessGrant,
  type Principal,
  provideDocAccess,
  type Reader,
  readerFor,
  type Scope,
} from "./access.ts";
export {
  type BriefStaleness,
  briefStaleness,
  briefView,
  loadBrief,
  recordBriefDrift,
  submitBrief,
} from "./brief.ts";
export {
  DOC_INDEX_QUEUE,
  type DocIndexJob,
  indexExtract,
  provideDocIndexJobs,
  registerDocIndexWorker,
  searchDocs,
} from "./doc-search.ts";
export {
  archiveDoc,
  assertDocSecrets,
  DOC_SYNC_ACTOR,
  type DocSavedEvent,
  type DocSavedHook,
  DocSecretError,
  type DocSource,
  docContentHash,
  docHistory,
  docScope,
  getDoc,
  listDocs,
  provideDocSaved,
  restoreDoc,
  type SyncDocWrite,
  saveDoc,
  saveDocFromSync,
} from "./docs.ts";
export {
  assistOutput,
  assistScope,
  draftForAgent,
  editorState,
  saveDraft,
  saveRunDraft,
  submitDraft,
} from "./editor.ts";
export { createOpenAIEmbedder, type Embedder, EmbedderError } from "./embedder.ts";
export { type ImportReport, importLegacy, type LegacyImportOptions } from "./legacy-import.ts";
export { knowledgePrincipal, MCP_LIMITS, registerMcpTools } from "./mcp-tools.ts";
export {
  approveMemory,
  EMBED_QUEUE,
  type EmbedDeps,
  type EmbedJob,
  embedQuery,
  embedQueue,
  type KnowledgeDeps,
  listMemories,
  registerEmbedWorker,
  rejectMemory,
  runEmbed,
  type SearchOptions,
  searchMemory,
  supersedeMemory,
  type WriteMemoryInput,
  writeMemory,
} from "./memory.ts";
export { approveProposal, createProposal, listProposals, proposeDoc, rejectProposal } from "./proposals.ts";
export { type ReviewJobDeps, registerReviewWorker, remindOverdue } from "./review-jobs.ts";
export { docTypeOf, flatGates, gateApplies, requiredApprovals, requirementsOf, slaOf } from "./review-rules.ts";
export {
  AI_AUTO_ACTOR,
  type AuthorFixRequest,
  type AutoCheckpoint,
  type AutoDecideRequest,
  type AutoDecision,
  aiGateContext,
  applyAiResult,
  attachGateRun,
  type BaselineEvent,
  completeWaitingGate,
  type DerivedWorkflow,
  decideReview,
  eligible,
  listCodeWorkflows,
  provideReviewHooks,
  REVIEW_QUEUE,
  type ReviewDeps,
  type ReviewHooks,
  type ReviewJob,
  type RuleContextExtras,
  reviewQueue,
  type StartReviewOptions,
  startReview,
  type TraceRequest,
} from "./reviews.ts";
export { type BriefPort, type DocAssistPort, knowledgeRouter } from "./router.ts";
export { handleRunSkills } from "./run-skills.ts";
export {
  applyLearnedSkill,
  assertCanManageScope,
  currentSkillContent,
  findSkillForProject,
  hasSkillRepo,
  type LearningCorpus,
  openLearnedSkillPR,
  skillLearningCorpus,
} from "./skill-learning.ts";
export { getPackSkill, listSkillPack, setSkillPack } from "./skill-pack.ts";
export {
  handleSkillWebhook,
  registerSkillGitWorker,
  SKILL_GIT_QUEUE,
  type SkillGitJob,
  type SkillRepoDeps,
  skillGitQueue,
  syncSkillRepo,
} from "./skill-repo.ts";
export { currentSkillVersion as skillVersionIn, getSkill, listSkills, saveSkill } from "./skills.ts";
