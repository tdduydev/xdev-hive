import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy*/waitFor mặc định chỉ chờ 1 giây; lúc CI hoặc máy dev đang bận, test đầu tiên dựng markdown (nạp module
// lần đầu) vượt ngưỡng đó dù component vẫn đúng. Mốc 10 giây nằm dưới testTimeout (20 giây).
configure({ asyncUtilTimeout: 10_000 });

afterEach(cleanup);
