# Cài hoặc nâng cấp hive-worker và lệnh hive trên Windows từ bản phát hành của xDev Hive. Chạy được trên Windows PowerShell 5.1.
#
#   irm https://github.com/tdduydev/xdev-hive/releases/latest/download/install.ps1 -OutFile "$env:TEMP\hive-install.ps1"
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\hive-install.ps1" -Hub URL -Token MÃ
#
# Chạy từ file (không qua iex): PowerShell 5.1 chỉ đọc đúng UTF-8 khi file có BOM, nên file này lưu kèm BOM. Chỉ dùng
# lớp .NET thay cho Get-FileHash, Expand-Archive vì hai lệnh đó không nạp được khi powershell.exe được gọi từ pwsh 7.
#
# Có -Token: cài hai binary, đăng ký máy với hub rồi cài tác vụ chạy nền khi đăng nhập. Không có -Token: chỉ thay hai binary
# bằng bản mới và khởi động lại tác vụ nếu đang chạy, nên chạy lại đúng lệnh này là cách nâng cấp.
# HIVE_RELEASES_URL thay trang phát hành bằng bản sao nội bộ có cùng cấu trúc thư mục.
param(
  [string]$Hub = $env:HIVE_HUB_URL,
  [string]$Token = $env:HIVE_REGISTRATION_TOKEN,
  [string]$Machine = "",
  [int]$Capacity = 1,
  [string]$Version = $(if ($env:HIVE_WORKER_VERSION) { $env:HIVE_WORKER_VERSION } else { "latest" }),
  [string]$Dir = $(if ($env:HIVE_INSTALL_DIR) { $env:HIVE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "xdev-hive\bin" }),
  [switch]$NoService,
  # Không thêm thư mục cài vào PATH của người dùng (khi tự quản lý PATH).
  [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"
# Thông báo tiếng Việt ra đúng khi chạy trong Windows Terminal hoặc bị chuyển hướng; cửa sổ không có console thì bỏ qua.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
# Invoke-WebRequest của PowerShell 5.1 chậm hẳn khi vẽ thanh tiến trình.
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$releases = if ($env:HIVE_RELEASES_URL) { $env:HIVE_RELEASES_URL } else { "https://github.com/tdduydev/xdev-hive/releases" }
$Version = $Version.TrimStart("v")
if ($Token -and -not $Hub) { throw "Cần -Hub khi có -Token." }

# PowerShell 32 bit trên Windows 64 bit báo x86 ở PROCESSOR_ARCHITECTURE; CPU thật nằm ở PROCESSOR_ARCHITEW6432.
$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($cpu) {
  "AMD64" { "amd64" }
  "ARM64" { "arm64" }
  default { throw "Chưa có bản dựng cho CPU $cpu." }
}
$base = if ($Version -eq "latest") { "$releases/latest/download" } else { "$releases/download/v$Version" }
$asset = "hive-worker_windows_$arch.zip"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hive-worker-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

# Khoá công khai ký checksums.txt; phải giống worker/internal/update/release-signing.pem (test Go kiểm).
$releaseKey = @"
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECNJFCSV1DBE0CC+kFeD8/XczocK2
ljQvs/rj+YhGueIFOP6GBwd+ROnZSkb3O7I7iAtvCwOQdEiLpXXAdM0Umw==
-----END PUBLIC KEY-----
"@

# .NET Framework của PowerShell 5.1 không đọc được khoá PEM hay chữ ký DER, nên tự tách: khoá P-256 dạng
# SubjectPublicKeyInfo dài 91 byte, 64 byte cuối là toạ độ X, Y; chữ ký DER là SEQUENCE { INTEGER r, INTEGER s },
# đổi thành r||s mỗi số 32 byte.
function Test-ReleaseSignature([byte[]]$Data, [byte[]]$Signature) {
  $body = ($releaseKey -split "`n" | Where-Object { $_ -and $_ -notmatch "-----" }) -join ""
  $spki = [Convert]::FromBase64String($body.Trim())
  if ($spki.Length -ne 91 -or $spki[26] -ne 4) { throw "Khoá ký bản phát hành không phải P-256." }
  $params = New-Object Security.Cryptography.ECParameters
  $params.Curve = [Security.Cryptography.ECCurve+NamedCurves]::nistP256
  $point = New-Object Security.Cryptography.ECPoint
  $point.X = $spki[27..58]
  $point.Y = $spki[59..90]
  $params.Q = $point
  $ecdsa = [Security.Cryptography.ECDsa]::Create($params)

  $i = 0
  if ($Signature[$i++] -ne 0x30) { return $false }
  if ($Signature[$i++] -band 0x80) { $i++ }
  $parts = @()
  foreach ($n in 1..2) {
    if ($Signature[$i++] -ne 0x02) { return $false }
    $len = $Signature[$i++]
    $int = $Signature[$i..($i + $len - 1)]
    $i += $len
    while ($int.Length -gt 32 -and $int[0] -eq 0) { $int = $int[1..($int.Length - 1)] }
    if ($int.Length -gt 32) { return $false }
    $parts += , ([byte[]](@(0) * (32 - $int.Length)) + [byte[]]$int)
  }
  $raw = [byte[]]($parts[0] + $parts[1])
  return $ecdsa.VerifyData($Data, $raw, [Security.Cryptography.HashAlgorithmName]::SHA256)
}

try {
  foreach ($name in @("checksums.txt", "checksums.txt.sig", $asset)) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile (Join-Path $tmp $name)
    } catch {
      throw "Không tải được $base/$name : $($_.Exception.Message)"
    }
  }
  $sums = [IO.File]::ReadAllBytes((Join-Path $tmp "checksums.txt"))
  $sig = [IO.File]::ReadAllBytes((Join-Path $tmp "checksums.txt.sig"))
  if (-not (Test-ReleaseSignature $sums $sig)) { throw "Chữ ký của checksums.txt không hợp lệ; không cài bản này." }
  $want = $null
  foreach ($line in [Text.Encoding]::UTF8.GetString($sums) -split "`n") {
    $fields = $line.Trim() -split "\s+"
    if ($fields.Length -eq 2 -and $fields[1].TrimStart("*") -eq $asset) { $want = $fields[0].ToLowerInvariant() }
  }
  if (-not $want) { throw "Bản phát hành không có $asset." }
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes((Join-Path $tmp $asset)))
  $got = ([BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
  if ($got -ne $want) { throw "sha256 của $asset không khớp checksums.txt." }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $tmp $asset), (Join-Path $tmp "x"))
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $bin = Join-Path $Dir "hive-worker.exe"
  $new = Join-Path $Dir ".hive-worker.new.exe"
  $hiveBin = Join-Path $Dir "hive.exe"
  $hiveNew = Join-Path $Dir ".hive.new.exe"
  # Bản phát hành cũ (trước khi có lệnh hive) không có hive.exe trong gói: chỉ cài worker.
  $hasHive = Test-Path (Join-Path $tmp "x\hive.exe")
  # Cả hai file tạm được chạy thử trước khi đổi tên, để lỗi ở file nào cũng không làm hai binary lệch phiên bản.
  function Remove-Staged { Remove-Item -Force -ErrorAction SilentlyContinue $new, $hiveNew }
  Copy-Item -Force (Join-Path $tmp "x\hive-worker.exe") $new
  $installed = (& $new version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Remove-Staged; throw "Bản vừa tải không chạy được trên máy này." }
  if ($hasHive) {
    Copy-Item -Force (Join-Path $tmp "x\hive.exe") $hiveNew
    # hive in "hive <phiên bản>" ở dòng đầu rồi thoát khác 0 khi worker chưa chạy, nên chỉ đọc dòng đầu.
    $hiveOut = @(& $hiveNew version 2>$null)
    $hiveInstalled = if ($hiveOut.Count -gt 0) { ([string]$hiveOut[0]).Trim() -split "\s+" | Select-Object -Last 1 } else { "" }
    if (-not $hiveInstalled) { Remove-Staged; throw "Lệnh hive vừa tải không chạy được trên máy này." }
    if ($hiveInstalled -ne $installed) { Remove-Staged; throw "hive báo phiên bản $hiveInstalled, worker báo $installed." }
  }
  if ($Version -ne "latest" -and $installed -ne $Version) {
    Remove-Staged
    throw "Bản vừa tải báo phiên bản $installed, cần $Version."
  }
  # Windows không ghi đè được file đang chạy nhưng đổi tên được: dời bản cũ sang .old rồi đặt bản mới vào.
  foreach ($pair in @(@($hiveNew, $hiveBin, $hasHive), @($new, $bin, $true))) {
    if (-not $pair[2]) { continue }
    if (Test-Path $pair[1]) {
      Remove-Item -Force -ErrorAction SilentlyContinue "$($pair[1]).old"
      Move-Item -Force $pair[1] "$($pair[1]).old"
    }
    Move-Item -Force $pair[0] $pair[1]
  }
  Write-Host "Đã cài hive-worker $installed vào $bin"
  if ($hasHive) { Write-Host "Đã cài hive $installed vào $hiveBin" }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $NoPathUpdate -and -not (($userPath -split ";") -contains $Dir)) {
    [Environment]::SetEnvironmentVariable("Path", (@($userPath, $Dir) | Where-Object { $_ }) -join ";", "User")
    Write-Host "Đã thêm $Dir vào PATH của người dùng; mở cửa sổ mới để gõ được hive-worker và hive."
  }

  if ($Token) {
    $cmdArgs = @("register", "--hub", $Hub, "--capacity", $Capacity)
    if ($Machine) { $cmdArgs += @("--machine", $Machine) }
    # Token đi qua biến môi trường để không hiện trong danh sách tiến trình.
    $env:HIVE_REGISTRATION_TOKEN = $Token
    try { & $bin @cmdArgs } finally { Remove-Item Env:HIVE_REGISTRATION_TOKEN }
    if ($LASTEXITCODE -ne 0) { throw "Đăng ký máy không thành công." }
    if (-not $NoService) {
      & $bin service install --capacity $Capacity
      if ($LASTEXITCODE -ne 0) { throw "Cài tác vụ chạy nền không thành công." }
    }
  } elseif (-not $NoService) {
    & $bin service restart
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}
