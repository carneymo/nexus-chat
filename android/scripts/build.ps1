param([switch]$Debug, [switch]$Offline, [string]$JavaHome = 'C:/Program Files/Android/Android Studio/jbr')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$env:JAVA_HOME = $JavaHome
$env:GRADLE_USER_HOME = Join-Path $projectRoot '.tools/gradle-user'
$env:ANDROID_USER_HOME = Join-Path $projectRoot '.tools/android-user'
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $projectRoot '.tools/sdk' }
$gradle = Join-Path $projectRoot '.tools/gradle-8.13/bin/gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) { $gradle = Join-Path $projectRoot 'gradlew.bat' }
if (-not $Debug -and -not (Test-Path -LiteralPath (Join-Path $projectRoot 'signing.properties'))) {
    throw 'Create or restore release signing material before building a distributable APK.'
}
Push-Location $projectRoot
try {
    $variant = if ($Debug) { 'Debug' } else { 'Release' }
    $gradleArguments = @('--no-daemon', "test${variant}UnitTest", "lint${variant}", "assemble${variant}")
    if ($Offline) { $gradleArguments += '--offline' }
    & $gradle @gradleArguments
    if ($LASTEXITCODE -ne 0) { throw 'Android validation/build failed.' }
    $name = $variant.ToLowerInvariant()
    $apk = Join-Path $projectRoot "app/build/outputs/apk/$name/app-$name.apk"
    & (Join-Path $env:ANDROID_HOME 'build-tools/35.0.0/apksigner.bat') verify --verbose $apk
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $output = Join-Path $projectRoot 'releases'
    [IO.Directory]::CreateDirectory($output) | Out-Null
    $metadata = Get-Content -Raw -LiteralPath (Join-Path (Split-Path $apk -Parent) 'output-metadata.json') | ConvertFrom-Json
    $version = $metadata.elements[0].versionName
    $target = Join-Path $output "Nexus-Chat-$version-$name.apk"
    Copy-Item -LiteralPath $apk -Destination $target
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$target.sha256", "$hash  $([IO.Path]::GetFileName($target))`n")
    Write-Output "Verified APK: $target"
} finally { Pop-Location }
