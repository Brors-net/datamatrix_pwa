$out = 'vendor\\zbar-wasm'
Set-Location -Path $out
Write-Output "Working dir: $(Get-Location)"

Write-Output 'Running npm pack zbar-wasm...'
$npmOut = npm pack zbar-wasm 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Output "npm pack failed: $npmOut"
  exit 1
}

$tgz = Get-ChildItem -Filter 'zbar-wasm*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $tgz) {
  Write-Output 'No tgz found after npm pack'
  exit 1
}
Write-Output "Found package: $($tgz.FullName)"

Write-Output 'Extracting tarball...'
tar -xf $tgz.FullName -C .

if (Test-Path package\dist) {
  Copy-Item -Path package\dist\* -Destination . -Force
  Write-Output 'Copied package/dist/* into vendor/zbar-wasm'
} else {
  Write-Output 'package\\dist not found after extraction'
}
