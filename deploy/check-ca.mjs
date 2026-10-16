import { X509Certificate } from "node:crypto";
import { get } from "node:https";
import { isIP } from "node:net";
import { setTimeout } from "node:timers/promises";

const base = new URL(process.argv[2]);
// IP dùng CA nội bộ của Caddy nên chỉ kiểm được /ca.crt. Tên miền phải có chứng chỉ mà CA hệ thống tin, như trình
// duyệt và worker sẽ thấy, không cần /ca.crt.
const trusted = isIP(base.hostname.replace(/^\[|\]$/g, "")) === 0;
// Let's Encrypt chỉ bắt đầu cấp khi Caddy đã chạy và phải chờ bản ghi TXT lan ra, nên tên miền chờ lâu hơn.
const attempts = trusted ? 24 : 3;
// Tham số thứ hai (ms) chỉ để test rút ngắn thời gian chờ.
const delay = Number(process.argv[3]) || (trusted ? 5_000 : 1_000);

function checkCa() {
  return new Promise((resolve, reject) => {
    // CA nội bộ chưa nằm trong kho tin cậy của hub; phép thử chỉ kiểm endpoint, không cài hay tin CA.
    const request = get(
      new URL("/ca.crt", base),
      { rejectUnauthorized: false, signal: AbortSignal.timeout(10_000) },
      (response) => {
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
      },
    );
    request.on("error", reject);
  });
}

function checkTrusted() {
  return new Promise((resolve, reject) => {
    const request = get(new URL("/api/v1/health", base), { signal: AbortSignal.timeout(10_000) }, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error(`HTTP ${response.statusCode}`));
    });
    request.on("error", reject);
  });
}

for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    await (trusted ? checkTrusted() : checkCa());
    console.log(
      trusted ? `Đạt: ${base.origin} có chứng chỉ được CA hệ thống tin.` : "Đạt: /ca.crt trả về chứng chỉ PEM hợp lệ.",
    );
    break;
  } catch (error) {
    if (attempt === attempts) {
      console.error(
        trusted
          ? `Chứng chỉ của ${base.origin} chưa được CA hệ thống tin sau ${attempts} lần thử: ${error.message}`
          : `Không tải được chứng chỉ PEM hợp lệ từ /ca.crt sau ${attempts} lần thử.`,
      );
      process.exitCode = 1;
    } else {
      // Caddy có thể còn đang cấp chứng chỉ ngay sau khi container vừa chạy.
      await setTimeout(delay);
    }
  }
}
