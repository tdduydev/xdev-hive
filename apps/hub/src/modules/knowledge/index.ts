// Tri thức dùng chung cho agent: memory, tài liệu, skill, đề xuất sửa. Module khác chỉ import file này.
// Các hàm nhận (tx, principal, input) là API public để cổng MCP gắn tool vào: tx là transaction withTenant của tổ
// chức, principal là người dùng hoặc run đã được xác thực.
export type { Principal } from "./access.ts";
export { docHistory, getDoc, listDocs, saveDoc } from "./docs.ts";
export { createOpenAIEmbedder, type Embedder, EmbedderError } from "./embedder.ts";
export { type ImportReport, importLegacy, type LegacyImportOptions } from "./legacy-import.ts";
export { MCP_LIMITS, registerMcpTools } from "./mcp-tools.ts";
export {
  EMBED_QUEUE,
  type EmbedDeps,
  type EmbedJob,
  embedQuery,
  embedQueue,
  type KnowledgeDeps,
  listMemories,
  registerEmbedWorker,
  runEmbed,
  type SearchOptions,
  searchMemory,
  supersedeMemory,
  type WriteMemoryInput,
  writeMemory,
} from "./memory.ts";
export { approveProposal, createProposal, listProposals, proposeDoc, rejectProposal } from "./proposals.ts";
export { knowledgeRouter } from "./router.ts";
export { getSkill, listSkills, saveSkill } from "./skills.ts";
