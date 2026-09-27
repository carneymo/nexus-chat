param([string]$JavaHome = 'C:/Program Files/Android/Android Studio/jbr')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$settings = ConvertFrom-StringData (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'signing.properties'))
$passwordPath = Join-Path $projectRoot '.tools/certificate-password'
$certificatePath = Join-Path $projectRoot '.tools/release-certificate.der'
[IO.File]::WriteAllText($passwordPath, $settings.storePassword)
try {
    & (Join-Path $JavaHome 'bin/keytool.exe') -exportcert -alias $settings.keyAlias -keystore (Join-Path $projectRoot $settings.storeFile) -storepass:file $passwordPath -file $certificatePath
    if ($LASTEXITCODE -ne 0) { throw 'Could not export the public release certificate.' }
    $hex = (Get-FileHash -LiteralPath $certificatePath -Algorithm SHA256).Hash
    $fingerprint = ($hex -split '(.{2})' | Where-Object { $_ }) -join ':'
    $association = @(@{
        relation = @('delegate_permission/common.handle_all_urls')
        target = @{ namespace = 'android_app'; package_name = 'net.nexuschat.android'; sha256_cert_fingerprints = @($fingerprint) }
    })
    $targetDirectory = Join-Path (Split-Path $projectRoot -Parent) 'public/.well-known'
    [IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
    $target = Join-Path $targetDirectory 'assetlinks.json'
    if (Test-Path -LiteralPath $target) { throw 'An App Links association already exists. Review and merge certificates instead of overwriting it.' }
    [IO.File]::WriteAllText($target, (ConvertTo-Json -InputObject $association -Depth 5))
    Write-Output "Public App Links association prepared: $target"
} finally {
    if (Test-Path -LiteralPath $passwordPath) { Remove-Item -LiteralPath $passwordPath }
}
