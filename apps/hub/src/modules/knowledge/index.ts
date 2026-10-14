// Tri thức dùng chung cho agent: memory, tài liệu, skill, đề xuất sửa. Module khác chỉ import file này.
// Các hàm nhận (tx, principal, input) là API public để cổng MCP gắn tool vào: tx là transaction withTenant của tổ
// chức, principal là người dùng hoặc run đã được xác thực.
export { type Principal, type Reader, readerFor, type Scope } from "./access.ts";
export {
  type BriefStaleness,
  briefStaleness,
  briefView,
  loadBrief,
  recordBriefDrift,
  submitBrief,
} from "./brief.ts";
export { docHistory, getDoc, listDocs, saveDoc } from "./docs.ts";
export {
  assistOutput,
  assistScope,
  draftForAgent,
} from "./editor.ts";
export { createOpenAIEmbedder, type Embedder, EmbedderError } from "./embedder.ts";
export { type ImportReport, importLegacy, type LegacyImportOptions } from "./legacy-import.ts";
export { MCP_LIMITS, registerMcpTools } from "./mcp-tools.ts";
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
export { flatGates, requiredApprovals, slaOf } from "./review-rules.ts";
export {
  aiGateContext,
  applyAiResult,
  attachGateRun,
  completeWaitingGate,
  eligible,
  listCodeWorkflows,
  REVIEW_QUEUE,
  type ReviewJob,
  reviewQueue,
  startReview,
} from "./reviews.ts";
export { type BriefPort, type DocAssistPort, knowledgeRouter } from "./router.ts";
export { handleRunSkills } from "./run-skills.ts";
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
export { getSkill, listSkills, saveSkill } from "./skills.ts";
