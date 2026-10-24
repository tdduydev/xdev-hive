# Local secrets: back up, move to another machine, import from `.env`

Secrets saved in the desktop app (screen **Bí mật**) stay on the machine, in the operating system's key store
(Keychain, Windows Credential Manager, Secret Service). The hub never receives them, not even encrypted, so a hub
backup does not contain them. To keep a copy or move them to a new machine, export them to a password-protected
`.hivesecrets` file and keep that file yourself.

## Export

1. Open **Bí mật** and click **Xuất**.
2. Pick the secrets to export (all by default).
3. Type a password of at least 12 characters twice, then pick where to save the file.

The file holds the value, description, "every project" flag and project assignments of each secret you picked. It is
encrypted with a key derived from the password (Argon2id, then AES-256-GCM); secret names are encrypted too. Keep the
file somewhere private, such as a USB drive, a personal cloud folder or a password manager attachment, and keep the
password apart from it.

**A forgotten password cannot be recovered.** Nobody can open the file, including the hub and the xDev Hive team. Export
again from the old machine if it still has the secrets.

## Import on another machine

1. Open **Bí mật** and click **Nhập**, then pick the `.hivesecrets` file and type its password.
2. Check the preview. It lists each name with its state (new, same name, same name and value), the projects it will be
   assigned to and the projects not found on this machine. It never shows values.
3. Choose what to do with names that already exist: skip them (default) or overwrite them. Overwriting replaces the
   value and description and adds assignments; it does not remove existing ones.
4. Confirm. The result lists what happened to each name.

Projects are matched by git remote first, then by name. A secret whose project is not on this machine is still
imported; assign it later from the list. A project can hold at most 64 secrets: assignments over the limit are dropped
and listed in the result.

A wrong password and a modified or damaged file give the same error, "Sai mật khẩu hoặc file đã bị sửa.", and nothing
is imported. A file made by a newer version of xDev Hive is refused; update the app first.

## Import from a `.env` file

In **Nhập**, pick a `.env` file instead, then choose one project, **Mọi dự án** or no assignment. Lines are
`KEY=VALUE`; blank lines and `#` comments are skipped, `export KEY=` and quoted values are understood. Names that break
the naming rules are listed with the reason and do not block the others. The preview and conflict choice work as above.
Secrets cannot be exported to `.env`.

Delete the `.env` file afterwards if you no longer need it: the point is to keep values out of plain files.

## Without the desktop app

On a machine that runs only the worker, use the same commands the app uses. The password goes on stdin as JSON, never
as an argument:

```sh
read -rs PW   # not echoed, not in shell history
jq -Rn '{password: input}' <<<"$PW" | hive-worker secrets export --out backup.hivesecrets
jq -Rn '{password: input}' <<<"$PW" | hive-worker secrets import --in backup.hivesecrets --dry-run
jq -Rn '{password: input}' <<<"$PW" | hive-worker secrets import --in backup.hivesecrets --on-conflict skip
hive-worker secrets import --env .env --project <localId> --dry-run
```

`jq` reads the password from stdin and escapes quotes and backslashes. `--name` (repeatable) exports only some
secrets; `--force` overwrites an existing output file. `--all-projects` instead of `--project` makes `.env` secrets
apply to every project.

## What is logged

Each export or import (not the preview) adds one line to the local log under **Bí mật → Nhật ký**: the kind, the time
and the secret names. Values and the password are never logged.
