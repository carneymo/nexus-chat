param([string]$ApkPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $projectRoot '.tools/sdk' }
$adb = Join-Path $sdk 'platform-tools/adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw 'Android platform-tools are missing. Set ANDROID_HOME to your SDK.' }
if (-not $ApkPath) { $ApkPath = Join-Path $projectRoot 'releases/Nexus-Chat-0.1.1-release.apk' }
if (-not (Test-Path -LiteralPath $ApkPath)) { throw 'Build the release APK first.' }
if (-not (Test-Path -LiteralPath "$ApkPath.sha256")) { throw 'APK checksum sidecar is missing. Rebuild the APK.' }
$expected = ((Get-Content -Raw -LiteralPath "$ApkPath.sha256").Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash -ne $expected) { throw 'APK checksum does not match. Rebuild before installing.' }
$devices = & $adb devices
if ($LASTEXITCODE -ne 0) { throw 'Could not query Android devices.' }
$ready = @($devices | Where-Object { $_ -match '^\S+\s+device$' })
if ($ready.Count -ne 1) { throw 'Connect exactly one phone, enable USB debugging and accept its authorization prompt.' }
& $adb install -r $ApkPath
if ($LASTEXITCODE -ne 0) { throw 'Installation failed. Review the phone prompt and Android error above; do not uninstall if you need to preserve app data.' }
& $adb shell am start -n net.nexuschat.android/.MainActivity
if ($LASTEXITCODE -ne 0) { throw 'Installed, but could not launch Nexus. Open it on the phone.' }
Write-Output 'Nexus installed and opened. Sign in on the phone to begin acceptance testing.'
