import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, NetworkIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { useOrg } from "@/shell/org-context.ts";

const LABEL = "Xem trong cây giao việc";

/**
 * Lối mở cây giao việc từ trang task hay trang run (specs/028 FR-016). Không thuộc phiên Leader nào (việc cũ, việc
 * người tự giao) hay hub chưa có thủ tục thì không hiện gì: trang chính không được hỏng vì một lối phụ.
 */
export function TreeLinks(props: { taskId: string } | { runId: string }) {
  const { api } = useOrg();
  const navigate = useNavigate();
  const links = useQuery({ ...api.leader.tree.links.queryOptions({ input: props }), retry: false });
  const threads = links.data ?? [];
  if (threads.length === 0) return null;
  const className = "inline-flex items-center gap-1 text-primary hover:text-primary/90";
  if (threads.length === 1) {
    const [only] = threads as [(typeof threads)[number]];
    return (
      <Link to="/leader" search={{ thread: only.threadId, view: "tree" }} className={className}>
        <NetworkIcon aria-hidden="true" className="size-3.5" />
        {LABEL}
      </Link>
    );
  }
  // Task được nhiều phiên Leader giao (edge case của spec): hỏi người xem muốn mở cây của phiên nào.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={`${className} cursor-pointer`}>
        <NetworkIcon aria-hidden="true" className="size-3.5" />
        {LABEL}
        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72">
        {threads.map((thread) => (
          <DropdownMenuItem
            key={thread.threadId}
            onClick={() => void navigate({ to: "/leader", search: { thread: thread.threadId, view: "tree" } })}
          >
            <span className="truncate">{thread.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
