import { ORPCError, ValidationError } from "@orpc/server";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./modules/platform/index.ts";

/**
 * Đổi lỗi nghiệp vụ của module thành lỗi oRPC ở một chỗ, để module không phụ thuộc oRPC và mọi router trả cùng
 * một dạng lỗi. Chạy như client interceptor nên nằm trong procedure client: oRPC vẫn đối chiếu lỗi với errorMap
 * của hợp đồng, client nhận lỗi đã khai báo (có kiểu) chứ không phải lỗi lạ.
 */
export async function mapDomainErrors<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ForbiddenError) throw toORPC("FORBIDDEN", error);
    if (error instanceof NotFoundError) throw toORPC("NOT_FOUND", error);
    if (error instanceof ConflictError) throw toORPC("CONFLICT", error);
    if (error instanceof BadRequestError) throw toORPC("BAD_REQUEST", error);
    if (error instanceof ORPCError && error.code === "BAD_REQUEST" && error.cause instanceof ValidationError) {
      throw new ORPCError("BAD_REQUEST", {
        message: validationMessage(error.cause),
        data: error.data,
        cause: error.cause,
      });
    }
    throw error;
  }
}

function toORPC(code: string, error: ForbiddenError | NotFoundError | ConflictError | BadRequestError) {
  return new ORPCError(code, { message: error.message, data: { code: error.code }, cause: error });
}

/** Message mặc định của oRPC là tiếng Anh; nêu trường sai đầu tiên để người dùng sửa được ngay. */
function validationMessage(error: ValidationError): string {
  const first = error.issues[0];
  if (!first) return "Dữ liệu gửi lên không hợp lệ.";
  const path = (first.path ?? []).map((p) => (typeof p === "object" ? String(p.key) : String(p))).join(".");
  return path ? `Dữ liệu không hợp lệ ở trường ${path}: ${first.message}` : `Dữ liệu không hợp lệ: ${first.message}`;
}
