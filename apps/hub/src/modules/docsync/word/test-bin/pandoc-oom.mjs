// Pandoc giả hết bộ nhớ: runtime Haskell thoát mã 251 khi vượt +RTS -M.
process.stderr.write("pandoc: Heap exhausted;\n");
process.exit(251);
