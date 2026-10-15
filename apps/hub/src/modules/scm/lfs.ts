import type { FetchLike } from "./types.ts";

export interface LfsAction {
  href: string;
  header?: Record<string, string>;
}

/** LFS action URLs may point at signed object storage, so only provider credentials go to the batch endpoint. */
export async function lfsUpload(action: LfsAction, bytes: Uint8Array, fetcher: FetchLike = fetch): Promise<void> {
  const response = await fetcher(action.href, {
    method: "PUT",
    ...(action.header ? { headers: action.header } : {}),
    body: Buffer.from(bytes),
  });
  if (!response.ok) throw new Error(`LFS upload failed (${response.status})`);
}

export async function lfsDownload(action: LfsAction, fetcher: FetchLike = fetch): Promise<Uint8Array> {
  const response = await fetcher(action.href, action.header ? { headers: action.header } : {});
  if (!response.ok) throw new Error(`LFS download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
