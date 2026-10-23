import { eq, inArray } from "drizzle-orm";
import { artifactError, type DocProposer, type LinkTarget, readerUserId } from "../artifacts/index.ts";
import { ForbiddenError, NotFoundError } from "../platform/index.ts";
import { authorize, canRead, readerFor } from "./access.ts";
import { currentDocVersion } from "./docs.ts";
import { createProposal } from "./proposals.ts";
import { docs } from "./schema.ts";

/**
 * Tài liệu làm đích gắn artifact (specs/012 T065). Gắn là siêu dữ liệu, không sửa nội dung tài liệu: đòi quyền `write`
 * trên phạm vi của tài liệu (thành viên đội; tài liệu cấp tổ chức: quản trị tổ chức), không đi qua đề xuất.
 */
export function createDocLinkTarget(): LinkTarget {
  return {
    kind: "doc",
    assertWritable: async (tx, reader, docId) => {
      const userId = readerUserId(reader);
      if (!userId) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
      const [doc] = await tx.select().from(docs).where(eq(docs.id, docId));
      if (!doc) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
      try {
        await authorize(tx, await readerFor(tx, { kind: "user", userId }), doc, "write");
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ForbiddenError)
          throw artifactError("ARTIFACT_LINK_FORBIDDEN");
        throw error;
      }
    },
    projectOf: async (tx, docId) => {
      const [doc] = await tx.select({ projectId: docs.projectId }).from(docs).where(eq(docs.id, docId));
      return doc?.projectId ?? null;
    },
    titles: async (tx, reader, docIds) => {
      const userId = readerUserId(reader);
      if (!userId) return new Map();
      const knowledgeReader = await readerFor(tx, { kind: "user", userId });
      const rows = await tx.select().from(docs).where(inArray(docs.id, docIds));
      return new Map(rows.filter((d) => canRead(knowledgeReader, d)).map((d) => [d.id, d.title]));
    },
    existing: async (tx, docIds) => {
      const rows = await tx.select({ id: docs.id }).from(docs).where(inArray(docs.id, docIds));
      return new Set(rows.map((r) => r.id));
    },
  };
}

/**
 * "Chuyển thành tài liệu" (specs/012 FR-110): luôn đi qua đề xuất, không ghi thẳng tài liệu, nên quyền chỉ cần
 * `propose` và người duyệt vẫn là người quyết. `baseVersion` lấy ngay trong transaction này nên không lệch.
 */
export function createDocProposer(): DocProposer {
  return {
    propose: async (tx, { userId, key, title, content, reason }) => {
      const proposal = await createProposal(
        tx,
        { kind: "user", userId },
        { kind: "doc", key, title, content, baseVersion: await currentDocVersion(tx, key), reason },
      );
      return { proposalId: proposal.id };
    },
  };
}
