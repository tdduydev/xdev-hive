import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import {
  addReviewComment,
  deleteReviewComment,
  editReviewComment,
  listReviewComments,
  replyReviewComment,
  resolveReviewComment,
  retryReviewCommentSync,
} from "./comments.ts";
import {
  type DecideDeps,
  decideCodeReview,
  enqueueCodeReview,
  overrideCodeReview,
  recheckCodeReview,
} from "./decide.ts";
import { type CodeRunPort, dryRunCodeWorkflow, workflowFromProject } from "./dry-run.ts";
import { codeReviewFiles, countAwaiting, createFilesCache, getCodeReview, listCodeReviews } from "./queries.ts";

/** `runs` do module `runs` cài vào (nó import codereview nên không import ngược được). */
export function codeReviewsRouter(deps: OrgDeps & DecideDeps & { runs: CodeRunPort }) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.codeReviews).$context<RequestContext>().use(authed).use(inOrg);
  // Một bộ đệm diff cho cả tiến trình hub (D10); test truyền bộ riêng qua deps.
  const read = { ...deps, filesCache: deps.filesCache ?? createFilesCache() };
  return {
    codeReviews: {
      comments: {
        retrySync: os.comments.retrySync.handler(({ context: { tx, user }, input }) =>
          retryReviewCommentSync(tx, user.id, input.commentId, deps),
        ),
        list: os.comments.list.handler(({ context: { tx, user }, input }) =>
          listReviewComments(tx, user.id, input.reviewId),
        ),
        add: os.comments.add.handler(({ context: { tx, user }, input }) => addReviewComment(tx, user.id, input, deps)),
        reply: os.comments.reply.handler(({ context: { tx, user }, input }) =>
          replyReviewComment(tx, user.id, input, deps),
        ),
        edit: os.comments.edit.handler(({ context: { tx, user }, input }) =>
          editReviewComment(tx, user.id, input, deps),
        ),
        delete: os.comments.delete.handler(({ context: { tx, user }, input }) =>
          deleteReviewComment(tx, user.id, input.commentId, deps),
        ),
        resolve: os.comments.resolve.handler(({ context: { tx, user }, input }) =>
          resolveReviewComment(tx, user.id, input.threadId, true, deps),
        ),
        reopen: os.comments.reopen.handler(({ context: { tx, user }, input }) =>
          resolveReviewComment(tx, user.id, input.threadId, false, deps),
        ),
      },
      list: os.list.handler(({ context: { tx, user }, input }) => listCodeReviews(tx, user.id, input)),
      count: os.count.handler(({ context: { tx, user } }) => countAwaiting(tx, user.id)),
      get: os.get.handler(({ context: { tx, user }, input }) => getCodeReview(tx, user.id, input.id, read)),
      files: os.files.handler(({ context: { tx, user }, input }) => codeReviewFiles(tx, user.id, input.id, read)),
      decide: os.decide.handler(({ context: { tx, user }, input }) => decideCodeReview(tx, user.id, input, read)),
      override: os.override.handler(({ context: { tx, user }, input }) => overrideCodeReview(tx, user.id, input, read)),
      enqueue: os.enqueue.handler(({ context: { tx, user }, input }) => enqueueCodeReview(tx, user.id, input.id, read)),
      recheck: os.recheck.handler(({ context: { tx, user }, input }) => recheckCodeReview(tx, user.id, input.id, read)),
      dryRun: os.dryRun.handler(({ context: { tx, user }, input }) =>
        dryRunCodeWorkflow(tx, user.id, input, deps.runs),
      ),
      workflowFromProject: os.workflowFromProject.handler(({ context: { tx, user }, input }) =>
        workflowFromProject(tx, user.id, input.projectKey),
      ),
    },
  };
}
