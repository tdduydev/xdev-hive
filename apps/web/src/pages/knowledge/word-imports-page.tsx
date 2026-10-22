import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { WordImport, WordImportMode, WordImportState } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill, type PillProps } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { FileTextIcon } from "lucide-react";
import { useId, useState } from "react";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { useWordImportSupport } from "@/lib/build-info.ts";
import { When } from "@/pages/knowledge/common.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

type Tone = NonNullable<PillProps["tone"]>;

const IMPORT_STATE: Record<WordImportState, { text: string; tone: Tone }> = {
  uploading: { text: "Đang tải lên", tone: "neutral" },
  converting: { text: "Đang chuyển", tone: "neutral" },
  ready: { text: "Chờ xác nhận", tone: "warn" },
  committing: { text: "Đang tạo", tone: "neutral" },
  done: { text: "Hoàn tất", tone: "ok" },
  failed: { text: "Lỗi", tone: "bad" },
  cancelled: { text: "Đã huỷ", tone: "neutral" },
};

const MODE_LABEL: Record<WordImportMode, string> = {
  create: "Tạo tài liệu mới",
  update: "Cập nhật tài liệu",
  link: "Gắn với tài liệu",
};

const COUNT_LABEL: Record<keyof WordImport["counts"], { text: string; tone: Tone }> = {
  queued: { text: "chờ chuyển", tone: "neutral" },
  converting: { text: "đang chuyển", tone: "neutral" },
  ready: { text: "sẵn sàng", tone: "ok" },
  skipped: { text: "bỏ qua", tone: "neutral" },
  blockedSecret: { text: "có bí mật", tone: "bad" },
  failed: { text: "lỗi", tone: "bad" },
  proposed: { text: "đã gửi duyệt", tone: "sel" },
  cancelled: { text: "đã huỷ", tone: "neutral" },
  done: { text: "đã tạo", tone: "ok" },
};

/** Chỉ các trạng thái có file: một lượt hàng trăm file không nên in chín nhãn, phần lớn là 0. */
export function countParts(counts: WordImport["counts"]): { key: string; text: string; tone: Tone }[] {
  return (Object.keys(COUNT_LABEL) as (keyof WordImport["counts"])[])
    .filter((key) => counts[key] > 0)
    .map((key) => ({ key, text: `${counts[key]} ${COUNT_LABEL[key].text}`, tone: COUNT_LABEL[key].tone }));
}

/** Cập nhật và gắn lấy đường dẫn từ tài liệu đích, nên dòng "đích" nói tài liệu thay vì thư mục. */
export function importTarget(item: Pick<WordImport, "mode" | "targetDir" | "docKey">): string {
  if (item.mode === "create") return item.targetDir ? item.targetDir : "Thư mục gốc";
  return item.docKey ?? "—";
}

interface HomeOption {
  id: string;
  label: string;
}

/** Nhà mà người dùng đã nhập vào: kho của tổ chức và của từng dự án bật tài liệu gắn repo. */
function useHomes(): { homes: HomeOption[]; pending: boolean; error: unknown; retry: () => void } {
  const { api, org } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const orgHome = useQuery(api.docHomes.get.queryOptions({ input: {} }));
  const docProjects = (projects.data ?? []).filter((project) => project.settings.docs.enabled);
  const projectHomes = useQueries({
    queries: docProjects.map((project) => api.docHomes.get.queryOptions({ input: { project: project.key } })),
  });
  const homes: HomeOption[] = [];
  if (orgHome.data) homes.push({ id: orgHome.data.id, label: org.name ? `Tổ chức ${org.name}` : "Tổ chức" });
  docProjects.forEach((project, i) => {
    const home = projectHomes[i]?.data;
    if (home) homes.push({ id: home.id, label: `Dự án ${project.name}` });
  });
  const queries = [projects, orgHome, ...projectHomes];
  return {
    homes,
    pending: queries.some((query) => query.isPending),
    error: queries.find((query) => query.isError)?.error,
    retry: () => {
      for (const query of queries) if (query.isError) void query.refetch();
    },
  };
}

const STATE_ORDER = Object.keys(IMPORT_STATE) as WordImportState[];

export function WordImportsPage() {
  const { api } = useOrg();
  const support = useWordImportSupport();
  const ids = useId();
  const { homes, pending, error, retry } = useHomes();
  const [pickedHome, setPickedHome] = useState("");
  const [state, setState] = useState<WordImportState | "">("");
  const homeId = homes.some((home) => home.id === pickedHome) ? pickedHome : (homes[0]?.id ?? "");
  const list = useInfiniteQuery({
    ...api.wordImports.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        homeId,
        ...(state ? { state } : {}),
        limit: 50,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
    enabled: homeId !== "" && support.state === "on",
  });
  const items = [
    ...new Map((list.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item])).values(),
  ];
  return (
    <>
      <PageHeader
        crumb={<Link to="/knowledge/docs">← Tài liệu</Link>}
        title="Các lượt nhập Word"
        description="Lịch sử nhập file Word vào tài liệu của tổ chức."
        width="wide"
      />
      <PageBody width="wide">
        {support.state === "off" ? (
          <EmptyState
            icon={FileTextIcon}
            title="Hub chưa nhận file Word"
            description="Nhập Word đang tắt ở hub này, nên chưa có lượt nhập nào để xem."
          />
        ) : error ? (
          <LoadFailure error={error} retry={retry} />
        ) : pending || support.state === "unknown" ? (
          <TableSkeleton columns={5} label="Đang tải các lượt nhập…" />
        ) : homes.length === 0 ? (
          <EmptyState
            icon={FileTextIcon}
            title="Chưa có nơi lưu tài liệu"
            description="Cần cấu hình repo tài liệu của tổ chức hoặc dự án trước khi nhập file Word."
            action={
              <Link to="/knowledge/docs" className="text-primary underline">
                Về trang Tài liệu
              </Link>
            }
          />
        ) : (
          <div className="grid min-w-0 gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              {homes.length > 1 && (
                <label htmlFor={`${ids}-home`} className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  Nơi lưu
                  <NativeSelect
                    id={`${ids}-home`}
                    size="sm"
                    className="w-56 max-w-full"
                    value={homeId}
                    onChange={(e) => setPickedHome(e.target.value)}
                  >
                    {homes.map((home) => (
                      <option key={home.id} value={home.id}>
                        {home.label}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              )}
              <label htmlFor={`${ids}-state`} className="flex min-w-0 items-center gap-2 text-sm font-medium">
                Trạng thái
                <NativeSelect
                  id={`${ids}-state`}
                  size="sm"
                  className="w-44"
                  value={state}
                  onChange={(e) => setState(e.target.value as WordImportState | "")}
                >
                  <option value="">Tất cả</option>
                  {STATE_ORDER.map((key) => (
                    <option key={key} value={key}>
                      {IMPORT_STATE[key].text}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </div>
            {list.isPending && <TableSkeleton columns={5} label="Đang tải các lượt nhập…" />}
            {list.isError && <LoadFailure error={list.error} retry={() => list.refetch()} />}
            {list.data && items.length === 0 && (
              <EmptyState
                icon={FileTextIcon}
                title={state ? "Không có lượt nhập nào ở trạng thái này" : "Chưa có lượt nhập Word nào"}
                description={
                  state
                    ? "Chọn trạng thái khác hoặc bỏ lọc để xem các lượt khác."
                    : "Bấm “Nhập Word” ở trang Tài liệu để tải file Word lên. Mỗi lần tải là một lượt, và sẽ hiện ở đây."
                }
                compact
              />
            )}
            {items.length > 0 && (
              <div className="min-w-0 rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <Th>Lượt nhập</Th>
                      <Th>Người nhập</Th>
                      <Th>Ngày</Th>
                      <Th>Trạng thái</Th>
                      <Th>Số file</Th>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <ImportRow key={item.id} item={item} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {list.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="justify-self-center"
                disabled={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
              >
                Tải thêm
              </Button>
            )}
          </div>
        )}
      </PageBody>
    </>
  );
}

function ImportRow({ item }: { item: WordImport }) {
  const label = IMPORT_STATE[item.state];
  const parts = countParts(item.counts);
  return (
    <TableRow>
      <Td className="max-w-72 min-w-44 break-words">
        <Link
          to="/knowledge/docs/word-imports/$id"
          params={{ id: item.id }}
          className="font-medium text-primary underline"
        >
          {MODE_LABEL[item.mode]}
        </Link>
        <div className="font-mono text-xs break-all text-muted-foreground">{importTarget(item)}</div>
      </Td>
      <Td className="min-w-28 break-words">{item.createdBy.name ?? "—"}</Td>
      <Td className="whitespace-nowrap">
        <When iso={item.createdAt} />
      </Td>
      <Td>
        <Pill tone={label.tone}>{label.text}</Pill>
      </Td>
      <Td className="min-w-44">
        {parts.length === 0 ? (
          "—"
        ) : (
          <ul className="flex flex-wrap gap-1">
            {parts.map((part) => (
              <li key={part.key}>
                <Pill tone={part.tone} small>
                  {part.text}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </Td>
    </TableRow>
  );
}
