export interface RpcRequest {
  path: string;
  method: "GET" | "POST";
  body: string | null;
}

export interface RpcReply {
  status: number;
  body: string;
  contentType: string;
}

export type RpcTransport = (request: RpcRequest, signal: AbortSignal) => Promise<RpcReply>;
