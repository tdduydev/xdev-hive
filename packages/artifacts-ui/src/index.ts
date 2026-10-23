// Màn artifact dùng chung cho web và app desktop (spec 012 D15). App chủ chỉ dựng route, menu và `ArtifactsEnv`.
export { ARTIFACT_TYPE_ICON, ArtifactCard, type ArtifactCardProps } from "./card.tsx";
export { VersionCompare, type VersionCompareProps } from "./compare.tsx";
export { ConvertDialog, type ConvertDialogProps } from "./convert-dialog.tsx";
export { ArtifactDetail, type ArtifactDetailProps } from "./detail.tsx";
export { ArtifactEditor, type ArtifactEditorProps } from "./editor.tsx";
export {
  type ArtifactRef,
  type ArtifactsEnv,
  type ArtifactsLink,
  type ArtifactsOfflineCache,
  ArtifactsProvider,
  type CachedArtifact,
  type FixRequest,
  type Lang,
  useArtifactsEnv,
} from "./env.tsx";
export { artifactFileName, downloadText, sourceLanguage } from "./files.ts";
export { FixRequestDialog, type FixRequestDialogProps } from "./fix-request-dialog.tsx";
export { ArtifactLibrary, type ArtifactLibraryProps } from "./library.tsx";
export { LinkedArtifacts, type LinkedArtifactsProps, type LinkedTarget } from "./linked.tsx";
export { ArtifactPanel, type ArtifactPanelProps, type ArtifactSelection, panelTabs } from "./panel.tsx";
export { PublicLinkDialog, type PublicLinkDialogProps } from "./public-link-dialog.tsx";
export { PublicLinksTable, type PublicLinksTableProps } from "./public-links-table.tsx";
export { MAX_PAGE_ERRORS, SandboxFrame, type SandboxFrameProps } from "./sandbox-frame.tsx";
export { ShareDialog, type ShareDialogProps } from "./share-dialog.tsx";
export { type ArtifactsText, artifactsText } from "./text.ts";
export { VersionHistory, type VersionHistoryProps } from "./versions.tsx";
export { CodeViewer } from "./viewer/code.tsx";
export { ArtifactViewer, type ArtifactViewerProps } from "./viewer/index.tsx";
export { MarkdownViewer } from "./viewer/markdown.tsx";
