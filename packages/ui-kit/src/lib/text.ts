/** Lower case without diacritics, for search: "Tài liệu", "tai lieu" and "TAI LIEU" all fold to "tai lieu". */
export const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
