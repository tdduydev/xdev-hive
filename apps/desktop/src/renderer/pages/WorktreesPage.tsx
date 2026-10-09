// Worktree: the checkouts the runs made on this machine, with the cleanup the manager already had as a dialog.
import { Page, PageHeader } from "@xdev-hive/ui-kit/components/common";
import { useT } from "@xdev-hive/ui";
import { WorktreePanel } from "@xdev-hive/ui/components/Worktrees";

export function WorktreesPage() {
  const t = useT();
  return (
    <Page wide>
      <PageHeader title={t("desk.nav.worktrees")} subtitle={t("worktrees.hint")} />
      <div data-worktree-panel>
        <WorktreePanel />
      </div>
    </Page>
  );
}
