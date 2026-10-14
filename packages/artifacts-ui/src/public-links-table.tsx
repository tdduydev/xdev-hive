import type { ArtifactPublicLink, ArtifactPublicLinkOrgItem } from "@xdev-hive/contracts";

export interface PublicLinksTableProps {
  items: (ArtifactPublicLink | ArtifactPublicLinkOrgItem)[];
  onRevoke?: ((linkId: string) => void) | undefined;
}

/** Bảng link công khai cho màn quản trị (T031) và app. T023 điền. */
export function PublicLinksTable(_props: PublicLinksTableProps) {
  return null;
}
