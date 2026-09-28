// GitHub integration settings (pull requests). Browser-safe, like gitlab.ts. The merge request options
// (gitlab.mr: when, draft, labels, remote…) apply to GitHub pull requests too.
import { z } from "zod";

export const GITHUB_URL = "https://github.com";

export const githubSettingsSchema = z.object({
  /** https://github.com, or the URL of a GitHub Enterprise Server. */
  url: z.string().default(GITHUB_URL),
  /** Fine-grained personal access token: Contents and Pull requests (read and write) on the team's repositories. */
  token: z.string().default(""),
});
export type GitHubSettings = z.output<typeof githubSettingsSchema>;
