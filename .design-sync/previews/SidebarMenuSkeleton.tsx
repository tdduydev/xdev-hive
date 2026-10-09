import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuSkeleton } from "@xdev-hive/ui";

// The sidebar's loading state: the group's rows hold their place while the list loads.
export function LoadingGroup() {
  return (
    <div className="w-60 rounded-lg border border-line-subtle bg-sidebar text-sidebar-foreground">
      <SidebarGroup>
        <SidebarGroupLabel>Dự án</SidebarGroupLabel>
        <SidebarMenu>
          {[0, 1, 2, 3, 4].map((i) => (
            <SidebarMenuItem key={i}>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </div>
  );
}

export function TextOnly() {
  return (
    <div className="w-60 rounded-lg border border-line-subtle bg-sidebar p-2">
      <SidebarMenu>
        {[0, 1, 2].map((i) => (
          <SidebarMenuItem key={i}>
            <SidebarMenuSkeleton />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </div>
  );
}
