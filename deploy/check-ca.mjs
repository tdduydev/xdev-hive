import { X509Certificate } from "node:crypto";
import { get } from "node:https";
import { setTimeout } from "node:timers/promises";

const url = new URL("/ca.crt", process.argv[2]);

function checkCa() {
  return new Promise((resolve, reject) => {
    // CA nội bộ chưa nằm trong kho tin cậy của hub; phép thử chỉ kiểm endpoint, không cài hay tin CA.
    const request = get(url, { rejectUnauthorized: false, signal: AbortSignal.timeout(10_000) }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65_536) request.destroy(new Error("Phản hồi quá lớn."));
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          if (!body.trimStart().startsWith("-----BEGIN CERTIFICATE-----")) {
            throw new Error("Phản hồi không phải PEM.");
          }
          new X509Certificate(body);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await checkCa();
    console.log("Đạt: /ca.crt trả về chứng chỉ PEM hợp lệ.");
    break;
  } catch {
    if (attempt === 3) {
      console.error("Không tải được chứng chỉ PEM hợp lệ từ /ca.crt sau 3 lần thử.");
      process.exitCode = 1;
    } else {
      // Caddy có thể còn đang cấp chứng chỉ ngay sau khi container vừa chạy.
      await setTimeout(1_000);
    }
  }
}
