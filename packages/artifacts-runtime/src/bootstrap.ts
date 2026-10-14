import { MAX_FRAME_TEXT } from "./messages.ts";

/**
 * Mã chạy đầu tiên trong mọi khung. Là chuỗi JS thuần (không phải hàm TypeScript dùng `toString`) vì bundler của web/app có
 * thể đổi tên hay chèn hàm phụ vào hàm, còn chuỗi này được nhúng nguyên văn vào `<script>`. Không được chứa `</script`.
 *
 * - `ready`, `resize`: để trang cha đặt chiều cao và biết khung đã nạp.
 * - `error`, `console`: lỗi chạy, promise bị từ chối, `console.error`/`console.warn` (cho "Nhờ Leader sửa").
 * - Khung có origin mờ nên đọc `localStorage`/`sessionStorage` sẽ ném SecurityError và làm vỡ trang; thay bằng bộ nhớ trong.
 * - Gửi tới `*` vì khung không biết origin của trang cha; tin không chứa bí mật và trang cha kiểm `event.source`.
 * - Dừng gửi lỗi sau 200 tin: trang lặp `console.error` không được làm trang cha bận.
 */
export const BOOTSTRAP_SOURCE = `(function () {
  var LIMIT = ${MAX_FRAME_TEXT};
  var MAX_REPORTS = 200;
  var reports = 0;
  var send = function (message) {
    try { window.parent.postMessage(message, "*"); } catch (_) {}
  };
  var clip = function (text) {
    text = String(text);
    return text.length > LIMIT ? text.slice(0, LIMIT) : text;
  };
  var describe = function (value) {
    if (value instanceof Error) return value.name + ": " + value.message;
    if (typeof value === "string") return value;
    try { return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value); } catch (_) { return String(value); }
  };
  var report = function (message) {
    if (reports >= MAX_REPORTS) return;
    reports += 1;
    send(message);
  };

  var memoryStorage = function () {
    var data = new Map();
    return {
      get length() { return data.size; },
      key: function (i) { var keys = Array.from(data.keys()); return i in keys ? keys[i] : null; },
      getItem: function (k) { k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem: function (k, v) { data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(String(k)); },
      clear: function () { data.clear(); }
    };
  };
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (_) {}
  });

  window.addEventListener("error", function (event) {
    var where = event.lineno ? " (dòng " + event.lineno + ")" : "";
    report({ type: "error", kind: "runtime", message: clip((event.message || describe(event.error)) + where) });
  });
  window.addEventListener("unhandledrejection", function (event) {
    report({ type: "error", kind: "promise", message: clip(describe(event.reason)) });
  });
  ["error", "warn"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        report({ type: "console", level: level, message: clip(Array.prototype.map.call(arguments, describe).join(" ")) });
      } catch (_) {}
      return original.apply(console, arguments);
    };
  });

  var last = -1;
  var pending = false;
  var measure = function () {
    pending = false;
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    send({ type: "resize", height: height });
  };
  var schedule = function () {
    if (pending) return;
    pending = true;
    requestAnimationFrame(measure);
  };
  var start = function () {
    if (typeof ResizeObserver === "function") {
      var observer = new ResizeObserver(schedule);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    measure();
    send({ type: "ready" });
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();`;
