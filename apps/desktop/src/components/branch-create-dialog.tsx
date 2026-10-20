import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { useEffect, useId, useRef, useState } from "react";
import { BranchErrorBody } from "@/components/branch-switch-dialog.tsx";
import { shortPath } from "@/lib/folder.ts";
import {
  type BranchError,
  branchNameError,
  type CreateResult,
  createBranch,
  GitBranchError,
  type RepoBranches,
} from "@/lib/git-branches.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  name: string;
  namePlaceholder: string;
  checking: string;
  nameOk: string;
  exists: string;
  base: string;
  groupLocal: string;
  groupRemote: string;
  switchAfter: string;
  fetchFirst: string;
  fetchFirstLocal: string;
  fetchFailed: (remote: string) => string;
  create: string;
  creating: string;
  cancel: string;
  retry: string;
  carry: string;
  createAnyway: string;
  fromLocal: string;
}> = {
  vi: {
    title: "Tạo nhánh",
    name: "Tên nhánh",
    namePlaceholder: "vd. feature/ten-tinh-nang",
    checking: "Đang kiểm tên…",
    nameOk: "Tên dùng được.",
    exists: "Nhánh đã có. App không ghi đè nhánh sẵn có.",
    base: "Nhánh gốc",
    groupLocal: "Nhánh local",
    groupRemote: "Nhánh remote",
    switchAfter: "Đổi sang nhánh mới sau khi tạo",
    fetchFirst: "Fetch nhánh gốc trước",
    fetchFirstLocal: "Fetch nhánh gốc trước (chỉ với nhánh remote)",
    fetchFailed: (remote) => `Không fetch được từ ${remote}. Tạo từ bản đã có trên máy?`,
    create: "Tạo nhánh",
    creating: "Đang tạo…",
    cancel: "Huỷ",
    retry: "Thử lại",
    carry: "Tạo, mang thay đổi theo",
    createAnyway: "Vẫn tạo",
    fromLocal: "Tạo từ bản trên máy",
  },
  en: {
    title: "Create branch",
    name: "Branch name",
    namePlaceholder: "e.g. feature/my-feature",
    checking: "Checking the name…",
    nameOk: "The name is available.",
    exists: "The branch already exists. The app never overwrites an existing branch.",
    base: "Base branch",
    groupLocal: "Local branches",
    groupRemote: "Remote branches",
    switchAfter: "Switch to the new branch after creating it",
    fetchFirst: "Fetch the base branch first",
    fetchFirstLocal: "Fetch the base branch first (remote branches only)",
    fetchFailed: (remote) => `Could not fetch from ${remote}. Create from the copy already on this machine?`,
    create: "Create branch",
    creating: "Creating…",
    cancel: "Cancel",
    retry: "Try again",
    carry: "Create, carry changes",
    createAnyway: "Create anyway",
    fromLocal: "Create from local copy",
  },
};

// Chỉ ba mã này nói về chính ô tên hay nhánh gốc; mã khác (timeout, sidecar cũ…) để lần tạo thật báo.
const FIELD_CODES = new Set<BranchError["code"]>(["invalid_name", "exists", "not_found"]);

type Check = { state: "idle" | "checking" | "ok" } | { state: "bad"; error: BranchError };
type Ask = BranchError & { code: "fetch_failed" | "busy" | "dirty" };

const refLabel = (ref: string) => ref.replace(/^refs\/(?:heads|remotes)\//, "");
const isRemoteRef = (ref: string) => ref.startsWith("refs/remotes/");

/**
 * Tạo nhánh (US3): tên kiểm ngay khi gõ (`branchNameError`, rồi `--dry-run` của sidecar cho tên trùng), nhánh gốc,
 * "Đổi sang sau khi tạo", "Fetch nhánh gốc trước". Nhánh mới không có upstream (FR-013). Câu hỏi của sidecar (fetch
 * lỗi, agent đang chạy, thay đổi chưa commit) hiện ngay trong hộp thoại, một lần bấm để đồng ý.
 */
export function BranchCreateDialog({
  folder,
  repo,
  onClose,
  onCreated,
}: {
  folder: string;
  repo: RepoBranches;
  onClose: () => void;
  onCreated: (result: CreateResult) => void;
}) {
  const t = useT(text);
  const nameId = useId();
  const baseId = useId();
  const hintId = useId();

  const locals = repo.branches.filter((b) => b.kind === "local");
  // Nhánh remote đã có bản local không nằm trong `branches`, nhưng vẫn là gốc mặc định hợp lý (spec US3).
  const remotes = repo.branches.filter((b) => b.kind === "remote");
  const remoteRefs = [
    ...(repo.defaultRef && isRemoteRef(repo.defaultRef) ? [repo.defaultRef] : []),
    ...remotes.map((b) => b.ref).filter((r) => r !== repo.defaultRef),
  ];
  const localRefs = locals.map((b) => b.ref);
  const initialBase =
    repo.defaultRef ??
    locals.find((b) => b.isDefault)?.ref ??
    (repo.current.branch ? `refs/heads/${repo.current.branch}` : undefined) ??
    localRefs[0] ??
    "";

  const [name, setName] = useState("");
  const [base, setBase] = useState(initialBase);
  const [switchTo, setSwitchTo] = useState(true);
  const [fetchPref, setFetchPref] = useState<boolean | null>(null);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Câu hỏi đã được đồng ý; giữ qua các lần gọi lại để agent đã xác nhận không bị hỏi lại khi gặp `dirty`.
  const confirmed = useRef({ busy: false, carry: false });
  const [offline, setOffline] = useState(false);

  const remoteBase = isRemoteRef(base);
  const fetchOn = remoteBase && (fetchPref ?? true) && !offline;
  const localError = name === "" ? null : branchNameError(name);

  // Tên hay gốc đổi thì mọi lần xác nhận trước không còn đúng ngữ cảnh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `name`, `base` là thứ cần theo dõi, không dùng trong thân hàm.
  useEffect(() => {
    confirmed.current = { busy: false, carry: false };
    setOffline(false);
    setAsk(null);
  }, [name, base]);

  useEffect(() => {
    if (name === "" || branchNameError(name) !== null || !base) {
      setCheck({ state: "idle" });
      return;
    }
    let alive = true;
    setCheck({ state: "checking" });
    const timer = setTimeout(() => {
      createBranch(folder, name, base, { dryRun: true }).then(
        () => alive && setCheck({ state: "ok" }),
        (e: unknown) =>
          alive &&
          setCheck(
            e instanceof GitBranchError && FIELD_CODES.has(e.code) ? { state: "bad", error: e.info } : { state: "ok" },
          ),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [folder, name, base]);

  async function submit(skipFetch = false) {
    setBusy(true);
    setAsk(null);
    setProblem(null);
    try {
      onCreated(
        await createBranch(folder, name, base, {
          switchTo,
          fetch: fetchOn && !skipFetch,
          carry: confirmed.current.carry,
          confirmBusy: confirmed.current.busy,
        }),
      );
    } catch (e) {
      if (e instanceof GitBranchError) {
        if (FIELD_CODES.has(e.code)) setCheck({ state: "bad", error: e.info });
        else if (e.code === "fetch_failed" || e.code === "busy" || e.code === "dirty") setAsk(e.info as Ask);
        else setProblem(e.info.message + (e.info.detail ? `\n${e.info.detail}` : ""));
      } else {
        setProblem(errorText(e));
      }
      setBusy(false);
    }
  }

  function confirm(what: "busy" | "carry" | "offline") {
    if (what === "offline") setOffline(true);
    else confirmed.current = { ...confirmed.current, [what]: true };
    void submit(what === "offline");
  }

  const blocked = !name || localError !== null || check.state === "checking" || check.state === "bad" || !base;
  const nameMessage =
    localError ??
    (check.state === "bad"
      ? check.error.code === "exists"
        ? t.exists
        : check.error.message + (check.error.detail ? ` ${check.error.detail}` : "")
      : null);

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{shortPath(folder)}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked && !busy && !ask) void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>{t.name}</Label>
            <Input
              id={nameId}
              autoFocus
              translate="no"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={t.namePlaceholder}
              value={name}
              aria-invalid={nameMessage !== null}
              aria-describedby={hintId}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
            <p
              id={hintId}
              aria-live="polite"
              className={nameMessage ? "text-xs text-destructive" : "min-h-4 text-xs text-muted-foreground"}
            >
              {nameMessage ?? (check.state === "checking" ? t.checking : check.state === "ok" ? t.nameOk : "")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={baseId}>{t.base}</Label>
            <NativeSelect
              id={baseId}
              translate="no"
              className="font-mono"
              value={base}
              disabled={busy}
              onChange={(e) => setBase(e.target.value)}
            >
              {remoteRefs.length > 0 && (
                <NativeSelectOptGroup label={t.groupRemote}>
                  {remoteRefs.map((r) => (
                    <NativeSelectOption key={r} value={r}>
                      {refLabel(r)}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              )}
              {localRefs.length > 0 && (
                <NativeSelectOptGroup label={t.groupLocal}>
                  {localRefs.map((r) => (
                    <NativeSelectOption key={r} value={r}>
                      {refLabel(r)}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              )}
            </NativeSelect>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 cursor-pointer accent-primary"
              checked={switchTo}
              disabled={busy}
              onChange={(e) => setSwitchTo(e.target.checked)}
            />
            {t.switchAfter}
          </label>
          <label
            className={remoteBase ? "flex items-start gap-2 text-sm" : "flex items-start gap-2 text-sm opacity-60"}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
              checked={fetchOn}
              disabled={busy || !remoteBase}
              onChange={(e) => setFetchPref(e.target.checked)}
            />
            {remoteBase ? t.fetchFirst : t.fetchFirstLocal}
          </label>

          {problem && (
            <Alert variant="destructive" className="whitespace-pre-line break-words">
              {problem}
            </Alert>
          )}
          {ask?.code === "fetch_failed" && <Alert variant="destructive">{t.fetchFailed(ask.remote ?? "remote")}</Alert>}
          {ask && ask.code !== "fetch_failed" && <BranchErrorBody error={ask} />}

          <DialogActions>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t.cancel}
            </Button>
            {ask?.code === "fetch_failed" ? (
              <Button type="button" onClick={() => confirm("offline")}>
                {t.fromLocal}
              </Button>
            ) : ask?.code === "busy" ? (
              <Button type="button" variant="destructive" onClick={() => confirm("busy")}>
                {t.createAnyway}
              </Button>
            ) : ask?.code === "dirty" ? (
              <Button type="button" onClick={() => confirm("carry")}>
                {t.carry}
              </Button>
            ) : (
              <Button type="submit" disabled={blocked || busy}>
                {busy ? t.creating : problem ? t.retry : t.create}
              </Button>
            )}
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
