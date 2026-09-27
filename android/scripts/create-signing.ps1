param([string]$JavaHome = 'C:/Program Files/Android/Android Studio/jbr')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$signingPath = Join-Path $projectRoot 'signing.properties'
$keystorePath = Join-Path $projectRoot 'nexus-release.jks'
if ((Test-Path -LiteralPath $signingPath) -or (Test-Path -LiteralPath $keystorePath)) {
    throw 'Signing material already exists. Reuse it; never replace the key used by installed apps.'
}
$passwordBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
$password = [Convert]::ToHexString($passwordBytes)
$passwordPath = Join-Path $projectRoot '.tools/signing-password'
[IO.Directory]::CreateDirectory((Split-Path $passwordPath -Parent)) | Out-Null
[IO.File]::WriteAllText($passwordPath, $password)
try {
    & (Join-Path $JavaHome 'bin/keytool.exe') -genkeypair -noprompt -keystore $keystorePath -storetype PKCS12 -alias nexus -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Nexus Chat' -storepass:file $passwordPath -keypass:file $passwordPath
    if ($LASTEXITCODE -ne 0) { throw 'Key generation failed.' }
    [IO.File]::WriteAllText($signingPath, "storeFile=nexus-release.jks`nstorePassword=$password`nkeyAlias=nexus`nkeyPassword=$password`n")
} finally {
    # This exact temporary file is inside the Android project.
    if (Test-Path -LiteralPath $passwordPath) { Remove-Item -LiteralPath $passwordPath }
}
Write-Output 'Release signing material created. Back up nexus-release.jks and signing.properties privately together.'
