# Cài hoặc nâng cấp hive-worker trên Windows từ bản phát hành của xDev Hive. Chạy được trên Windows PowerShell 5.1.
#
#   & ([scriptblock]::Create((irm https://github.com/tdduydev/xdev-hive/releases/latest/download/install.ps1))) -Hub URL -Token MÃ
#
# Có -Token: cài binary, đăng ký máy với hub rồi cài tác vụ chạy nền khi đăng nhập. Không có -Token: chỉ thay binary
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
  $got = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $tmp $asset)).Hash.ToLowerInvariant()
  if ($got -ne $want) { throw "sha256 của $asset không khớp checksums.txt." }

  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath (Join-Path $tmp "x") -Force
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $bin = Join-Path $Dir "hive-worker.exe"
  $new = Join-Path $Dir ".hive-worker.new.exe"
  Copy-Item -Force (Join-Path $tmp "x\hive-worker.exe") $new
  $installed = (& $new version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Remove-Item -Force $new; throw "Bản vừa tải không chạy được trên máy này." }
  if ($Version -ne "latest" -and $installed -ne $Version) {
    Remove-Item -Force $new
    throw "Bản vừa tải báo phiên bản $installed, cần $Version."
  }
  # Windows không ghi đè được file đang chạy nhưng đổi tên được: dời bản cũ sang .old rồi đặt bản mới vào.
  if (Test-Path $bin) {
    Remove-Item -Force -ErrorAction SilentlyContinue "$bin.old"
    Move-Item -Force $bin "$bin.old"
  }
  Move-Item -Force $new $bin
  Write-Host "Đã cài hive-worker $installed vào $bin"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $NoPathUpdate -and -not (($userPath -split ";") -contains $Dir)) {
    [Environment]::SetEnvironmentVariable("Path", (@($userPath, $Dir) | Where-Object { $_ }) -join ";", "User")
    Write-Host "Đã thêm $Dir vào PATH của người dùng; mở cửa sổ mới để gõ được hive-worker."
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
