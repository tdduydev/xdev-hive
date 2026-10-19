import { docKey } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  commonPrefix,
  dropCommonPrefix,
  pick,
  planNames,
  proposePath,
  slug,
  stripNoisePrefix,
  stripVersion,
} from "./names.ts";

// Tên dựng lại từ mô tả 10 biến thể ở research.md mục 1, không phải tên file thật của 261 SRS.
const STANDARD = "eHosV2i_SRS_OPD.OPD17_v1.0.docx";

describe("stripVersion", () => {
  it.each([
    // [tên file, phần thân, nhãn phiên bản, số bản sao]
    [STANDARD, "eHosV2i_SRS_OPD.OPD17", "1.0", 0],
    ["HC_eHosV2i_SRS_OPD.OPD17_v1.0.docx", "HC_eHosV2i_SRS_OPD.OPD17", "1.0", 0],
    ["eHosV2i_SRS_OPD_OPD17_v1.0.docx", "eHosV2i_SRS_OPD_OPD17", "1.0", 0],
    ["eHosV2i_SRS_OPD.OPD17 v1.0.docx", "eHosV2i_SRS_OPD.OPD17", "1.0", 0],
    ["eHosV2i_SRS_OPD.OPD17_v1.0 -.docx", "eHosV2i_SRS_OPD.OPD17", "1.0", 0],
    ["eHosV2i_SRS_OPD.OPD17 - v1.2.docx", "eHosV2i_SRS_OPD.OPD17", "1.2", 0],
    ["eHosV2i_SRS_Common_v1.1.docx", "eHosV2i_SRS_Common", "1.1", 0],
    ["eHosV2i_SRS_OPD.OPD17_v2.docx", "eHosV2i_SRS_OPD.OPD17", "2", 0],
    ["eHosV2i_SRS_OPD.OPD17_v1.0_2.docx", "eHosV2i_SRS_OPD.OPD17", "1.0", 2],
    ["eHosV2i_SRS_OPD.OPD17.docx", "eHosV2i_SRS_OPD.OPD17", null, 0],
  ])("%s", (fileName, stem, version, copy) => {
    expect(stripVersion(fileName)).toEqual({ stem, ext: ".docx", version, copy });
  });

  it("giữ đuôi .odt, .doc đúng như đã gõ và không nhận phiên bản dính vào chữ", () => {
    expect(stripVersion("Mau.ODT")).toEqual({ stem: "Mau", ext: ".ODT", version: null, copy: 0 });
    expect(stripVersion("Mau v3.doc")).toEqual({ stem: "Mau", ext: ".doc", version: "3", copy: 0 });
    // "Nov1" không phải "No" + v1.
    expect(stripVersion("Nov1.docx").version).toBeNull();
    // Số của mã nằm trước dấu chấm không bị nuốt thành phiên bản.
    expect(stripVersion("OPD17v1.2.docx")).toMatchObject({ stem: "OPD17", version: "1.2" });
  });

  it("tên không có đuôi Word thì không cắt đuôi", () => {
    expect(stripVersion("eHosV2i_SRS_Common_v1.1")).toEqual({
      stem: "eHosV2i_SRS_Common",
      ext: "",
      version: "1.1",
      copy: 0,
    });
  });
});

describe("stripNoisePrefix", () => {
  it("bỏ tiền tố HC_ và báo là tên không chuẩn", () => {
    expect(stripNoisePrefix("HC_eHosV2i_SRS_OPD.OPD17")).toEqual({ stem: "eHosV2i_SRS_OPD.OPD17", standard: false });
    expect(stripNoisePrefix("hc eHosV2i")).toEqual({ stem: "eHosV2i", standard: false });
  });

  it("tên chuẩn giữ nguyên; HC không đứng riêng một từ thì không phải tiền tố", () => {
    expect(stripNoisePrefix("eHosV2i_SRS_OPD")).toEqual({ stem: "eHosV2i_SRS_OPD", standard: true });
    expect(stripNoisePrefix("HCM_ke_hoach")).toEqual({ stem: "HCM_ke_hoach", standard: true });
  });
});

describe("commonPrefix", () => {
  it("cắt ở dấu phân cách cuối cùng của phần chung", () => {
    expect(commonPrefix(["eHosV2i_SRS_OPD.OPD02", "eHosV2i_SRS_OPD.OPD17"])).toBe("eHosV2i_SRS_OPD.");
    expect(commonPrefix(["eHosV2i_SRS_Common", "eHosV2i_SRS_OPD.OPD17"])).toBe("eHosV2i_SRS_");
    expect(commonPrefix(["a-b c", "a-b d"])).toBe("a-b ");
  });

  it("không cắt giữa từ", () => {
    expect(commonPrefix(["OPD02", "OPD17"])).toBe("");
    expect(commonPrefix(["abc", "abd"])).toBe("");
  });

  it("chỉ áp dụng khi có từ hai tên khác nhau trở lên", () => {
    expect(commonPrefix([])).toBe("");
    expect(commonPrefix(["eHosV2i_SRS_OPD.OPD02"])).toBe("");
    // Hai bản của cùng một tài liệu chỉ là một tên.
    expect(commonPrefix(["eHosV2i_SRS_OPD.OPD02", "eHosV2i_SRS_OPD.OPD02"])).toBe("");
  });

  it("không áp dụng khi phần còn lại của một tên rỗng", () => {
    expect(commonPrefix(["SRS_OPD", "SRS_OPD_"])).toBe("");
    expect(commonPrefix(["SRS_", "SRS_OPD"])).toBe("");
  });

  it("coi . _ - và dấu cách là cùng một dấu phân cách khi so", () => {
    expect(commonPrefix(["eHosV2i_SRS_BIL.BIL05", "eHosV2i_SRS_BIL_BIL10"])).toBe("eHosV2i_SRS_BIL.");
    expect(commonPrefix(["eHosV2i SRS BIL 05", "eHosV2i-SRS-BIL-10"])).toBe("eHosV2i SRS BIL ");
  });

  it("không phân biệt hoa thường khi so, trả về theo tên đứng đầu theo mã ký tự", () => {
    expect(commonPrefix(["EHOS_a", "ehos_b"])).toBe("EHOS_");
    expect(commonPrefix(["ehos_b", "EHOS_a"])).toBe("EHOS_");
  });
});

describe("dropCommonPrefix", () => {
  it("cắt phần đầu chung khỏi mọi tên, giữ thứ tự đầu vào", () => {
    expect(dropCommonPrefix(["eHosV2i_SRS_BIL_BIL10", "eHosV2i_SRS_BIL.BIL05"])).toEqual(["BIL10", "BIL05"]);
  });

  it("không áp dụng thì trả lại nguyên tên", () => {
    expect(dropCommonPrefix(["OPD02", "OPD17"])).toEqual(["OPD02", "OPD17"]);
    expect(dropCommonPrefix(["eHosV2i_SRS_Common"])).toEqual(["eHosV2i_SRS_Common"]);
    expect(dropCommonPrefix(["SRS_", "SRS_OPD"])).toEqual(["SRS_", "SRS_OPD"]);
  });
});

describe("slug", () => {
  it("bỏ dấu, chữ thường, ký tự lạ thành -", () => {
    expect(slug("Đặc tả yêu cầu - Quản lý đăng ký khám")).toBe("dac-ta-yeu-cau-quan-ly-dang-ky-kham");
    expect(slug("  Ôn tập!!  (bản 2)  ")).toBe("on-tap-ban-2");
  });

  it("gộp dấu chấm và gạch dưới để các biến thể của cùng một mã ra cùng slug", () => {
    expect(slug("OPD.OPD17")).toBe("opd-opd17");
    expect(slug("OPD_OPD17")).toBe("opd-opd17");
    expect(slug("OPD OPD17")).toBe("opd-opd17");
  });

  it("chuẩn hoá cả dạng NFC lẫn NFD", () => {
    expect(slug("Quy trình".normalize("NFD"))).toBe(slug("Quy trình".normalize("NFC")));
  });

  it("luôn là key hợp lệ cho docKey", () => {
    for (const name of ["Đặc tả yêu cầu", "OPD.OPD17", "  ", "日本語", "a/b\\c", "..", "-x-"]) {
      expect(docKey.safeParse(`org/${slug(name)}`).success, name).toBe(true);
    }
  });

  it("tên không còn ký tự nào thì dùng tên dự phòng", () => {
    expect(slug("日本語")).toBe("tai-lieu");
  });
});

describe("proposePath", () => {
  it("ghép thư mục đích, thư mục con và tên, giữ hoa thường của tên", () => {
    expect(proposePath("docs/srs", "OPD", "OPD17")).toBe("docs/srs/OPD/OPD17.md");
    expect(proposePath("docs/srs/", "", "OPD17")).toBe("docs/srs/OPD17.md");
    expect(proposePath("", "", "OPD17")).toBe("OPD17.md");
  });

  it("bỏ dấu và đổi ký tự lạ ở tên lẫn từng thư mục con, chấp nhận cả dấu \\", () => {
    expect(proposePath("docs", "Quy trình\\Khám bệnh", "Đặc tả: nhập viện")).toBe(
      "docs/Quy-trinh/Kham-benh/Dac-ta-nhap-vien.md",
    );
  });

  it("bỏ đoạn rỗng, . và .. để không thoát khỏi thư mục đích", () => {
    expect(proposePath("docs", "../../etc/./x", "a")).toBe("docs/etc/x/a.md");
  });

  it("path luôn cho ra key hợp lệ sau khi hạ chữ thường", () => {
    const path = proposePath("docs/srs", "Phân hệ OPD", "Đặc tả OPD.17");
    expect(docKey.safeParse(`org/${path.toLowerCase()}`).success).toBe(true);
  });
});

type F = { name: string; lastModified?: number };
const f = (name: string, lastModified?: number): F => (lastModified === undefined ? { name } : { name, lastModified });

describe("pick", () => {
  it("cùng mã thì giữ phiên bản cao nhất và nói lý do bỏ bản kia", () => {
    const a = f("eHosV2i_SRS_OPD.OPD17_v1.0.docx");
    const b = f("eHosV2i_SRS_OPD.OPD17_v1.1.docx");
    expect(pick([a, b])).toEqual({ kept: [b], dropped: [{ file: a, winner: b, reason: "version" }] });
  });

  it("so phiên bản theo số, không theo chữ; 1.0 bằng 1.0.0; có phiên bản hơn không có", () => {
    const names = ["X_v1.9.docx", "X_v1.10.docx", "X_v1.2.docx", "X.docx"].map((n) => f(n));
    expect(pick(names).kept.map((x) => x.name)).toEqual(["X_v1.10.docx"]);
    const tie = pick([f("X_v1.0.docx", 1), f("X_v1.0.0.docx", 2)]);
    expect(tie.dropped[0]?.reason).toBe("modified");
    expect(pick([f("X.docx"), f("X_v0.1.docx")]).kept[0]?.name).toBe("X_v0.1.docx");
  });

  it("cùng phiên bản thì bản gốc thắng bản sao _n, bản sao nhỏ thắng bản sao lớn", () => {
    const orig = f("X_v1.0.docx");
    const c2 = f("X_v1.0_2.docx");
    const c3 = f("X_v1.0_3.docx");
    const result = pick([c3, c2, orig]);
    expect(result.kept).toEqual([orig]);
    expect(result.dropped.map((d) => [d.file.name, d.reason])).toEqual([
      ["X_v1.0_2.docx", "copy"],
      ["X_v1.0_3.docx", "copy"],
    ]);
  });

  it("cùng phiên bản và bản sao thì tên chuẩn thắng tên có tiền tố HC_", () => {
    const std = f("eHosV2i_SRS_BIL.BIL10_v1.0.docx", 1);
    const hc = f("HC_eHosV2i_SRS_BIL.BIL10_v1.0.docx", 2);
    expect(pick([hc, std])).toEqual({ kept: [std], dropped: [{ file: hc, winner: std, reason: "standard" }] });
  });

  it("sau đó đến ngày sửa mới hơn, rồi tên file", () => {
    const old = f("X_v1.0.docx", 100);
    const fresh = f("X v1.0.docx", 200);
    expect(pick([old, fresh])).toEqual({ kept: [fresh], dropped: [{ file: old, winner: fresh, reason: "modified" }] });

    const a = f("X_v1.0.docx", 100);
    const b = f("X v1.0.docx", 100);
    // "X_" đứng sau "X " theo thứ tự mã ký tự nên bản có dấu cách thắng.
    expect(pick([a, b])).toEqual({ kept: [b], dropped: [{ file: a, winner: b, reason: "filename" }] });
    // Có ngày sửa thắng không có ngày sửa.
    expect(pick([f("X_v1.0.docx"), f("X v1.0.docx", 1)]).kept[0]?.name).toBe("X v1.0.docx");
  });

  it("gom nhóm theo slug nên _ thay . và dấu cách vẫn là cùng một mã", () => {
    const dot = f("eHosV2i_SRS_OPD.OPD17_v1.0.docx");
    const under = f("eHosV2i_SRS_OPD_OPD17_v1.1.docx");
    expect(pick([dot, under]).kept).toEqual([under]);
  });

  it("mã khác nhau thì giữ cả hai", () => {
    const a = f("eHosV2i_SRS_OPD.OPD02_v1.0.docx");
    const b = f("eHosV2i_SRS_OPD.OPD17_v1.0.docx");
    expect(pick([a, b])).toEqual({ kept: [a, b], dropped: [] });
  });

  it("đảo thứ tự đầu vào không đổi kết quả", () => {
    const files = [
      f("eHosV2i_SRS_OPD.OPD17_v1.0.docx", 5),
      f("eHosV2i_SRS_OPD.OPD17_v1.1.docx", 1),
      f("eHosV2i_SRS_OPD.OPD17_v1.1_2.docx", 9),
      f("HC_eHosV2i_SRS_OPD.OPD17_v1.1.docx", 9),
      f("eHosV2i_SRS_OPD.OPD02_v1.0.docx"),
      f("eHosV2i_SRS_OPD.OPD02 v1.0 -.docx"),
      f("eHosV2i_SRS_Common_v1.1.docx", 3),
      f("Đặc tả đăng ký.docx"),
    ];
    const expected = JSON.stringify(pick(files));
    const orders = [[...files].reverse(), [...files.slice(4), ...files.slice(0, 4)]];
    for (const order of orders) expect(JSON.stringify(pick(order))).toBe(expected);
    // Thêm vài hoán vị xoay vòng.
    for (const shift of [1, 3, 5]) {
      expect(JSON.stringify(pick([...files.slice(shift), ...files.slice(0, shift)]))).toBe(expected);
    }
  });
});

describe("planNames", () => {
  const file = (path: string, lastModified?: number) => ({
    path,
    ...(lastModified === undefined ? {} : { lastModified }),
  });

  it("bỏ phần đầu chung và đuôi phiên bản trong từng thư mục con, đề xuất OPD02.md, OPD17.md", () => {
    const { planned, dropped } = planNames(
      [
        file("OPD/eHosV2i_SRS_OPD.OPD17_v1.0.docx"),
        file("OPD/HC_eHosV2i_SRS_OPD.OPD02_v1.0.docx"),
        file("OPD/eHosV2i_SRS_OPD.OPD02_v1.1.docx"),
        file("BIL/eHosV2i_SRS_BIL.BIL05_v1.0.docx"),
        file("BIL/eHosV2i_SRS_BIL_BIL10 v2.0 -.docx"),
      ],
      "docs/srs",
    );
    expect(planned.map((p) => [p.file.path, p.path, p.version])).toEqual([
      ["BIL/eHosV2i_SRS_BIL.BIL05_v1.0.docx", "docs/srs/BIL/BIL05.md", "1.0"],
      ["BIL/eHosV2i_SRS_BIL_BIL10 v2.0 -.docx", "docs/srs/BIL/BIL10.md", "2.0"],
      ["OPD/eHosV2i_SRS_OPD.OPD02_v1.1.docx", "docs/srs/OPD/OPD02.md", "1.1"],
      ["OPD/eHosV2i_SRS_OPD.OPD17_v1.0.docx", "docs/srs/OPD/OPD17.md", "1.0"],
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      file: { path: "OPD/HC_eHosV2i_SRS_OPD.OPD02_v1.0.docx" },
      winner: { path: "OPD/eHosV2i_SRS_OPD.OPD02_v1.1.docx" },
      reason: "version",
    });
  });

  it("phần đầu chung tính riêng từng thư mục: thư mục chỉ có một mã thì giữ nguyên tên", () => {
    const { planned } = planNames(
      [file("Common/eHosV2i_SRS_Common_v1.1.docx"), file("A/x_1.docx"), file("A/x_2.docx")],
      "docs",
    );
    expect(planned.map((p) => p.path)).toEqual(["docs/A/1.md", "docs/A/2.md", "docs/Common/eHosV2i-SRS-Common.md"]);
  });

  it("bản bị loại không tính vào phần đầu chung", () => {
    // Hai bản của một mã không tạo ra phần đầu chung giả.
    const { planned } = planNames(
      [file("eHosV2i_SRS_OPD.OPD02_v1.0.docx"), file("eHosV2i_SRS_OPD.OPD02_v1.1.docx")],
      "d",
    );
    expect(planned.map((p) => p.path)).toEqual(["d/eHosV2i-SRS-OPD-OPD02.md"]);
  });

  it("thư mục khác nhau không loại bản của nhau dù cùng tên", () => {
    const { planned, dropped } = planNames([file("A/x_v1.0.docx"), file("B/x_v1.0.docx")], "d");
    expect(planned.map((p) => p.path)).toEqual(["d/A/x.md", "d/B/x.md"]);
    expect(dropped).toEqual([]);
  });

  it("tên tiếng Việt có dấu và dấu cách", () => {
    const { planned } = planNames([file("Đặc tả đăng ký khám_v1.2.docx")], "docs");
    expect(planned.map((p) => p.path)).toEqual(["docs/Dac-ta-dang-ky-kham.md"]);
  });

  it("đảo thứ tự đầu vào không đổi kết quả", () => {
    const files = [
      file("OPD/eHosV2i_SRS_OPD.OPD17_v1.0.docx", 1),
      file("OPD/eHosV2i_SRS_OPD.OPD17_v1.0_2.docx", 2),
      file("OPD/HC_eHosV2i_SRS_OPD.OPD02_v1.0.docx", 3),
      file("OPD/eHosV2i_SRS_OPD.OPD02 v1.0.docx", 3),
      file("Common/eHosV2i_SRS_Common_v1.1.docx"),
      file("Đặc tả.docx"),
    ];
    const expected = JSON.stringify(planNames(files, "docs"));
    expect(JSON.stringify(planNames([...files].reverse(), "docs"))).toBe(expected);
    expect(JSON.stringify(planNames([...files.slice(2), ...files.slice(0, 2)], "docs"))).toBe(expected);
  });
});
