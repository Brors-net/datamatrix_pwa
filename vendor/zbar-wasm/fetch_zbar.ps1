$out='vendor\\zbar-wasm'
if(-not(Test-Path $out)){ New-Item -ItemType Directory -Path $out | Out-Null }

$urls=@(
  'https://unpkg.com/zbar-wasm@latest/dist/index.min.js',
  'https://cdn.jsdelivr.net/npm/zbar-wasm@latest/dist/index.min.js',
  'https://unpkg.com/zbar-wasm/dist/index.min.js'
)
$found=$false
foreach($u in $urls){
  try{
    Write-Output "Trying $u"
    Invoke-WebRequest -Uri $u -OutFile "$out\\index.min.js" -UseBasicParsing -ErrorAction Stop
    Write-Output "Saved index.min.js from $u"
    $found=$true
    break
  } catch {
    Write-Output "Failed: $u -> $($_.Exception.Message)"
  }
}
if(-not $found){ Write-Output 'index.min.js not found in tried URLs.' }

$wasmUrls=@(
  'https://unpkg.com/zbar-wasm@latest/dist/zbar.wasm',
  'https://cdn.jsdelivr.net/npm/zbar-wasm@latest/dist/zbar.wasm',
  'https://unpkg.com/zbar-wasm/dist/zbar.wasm'
)
$foundW=$false
foreach($u in $wasmUrls){
  try{
    Write-Output "Trying wasm $u"
    Invoke-WebRequest -Uri $u -OutFile "$out\\zbar.wasm" -UseBasicParsing -ErrorAction Stop
    Write-Output "Saved zbar.wasm from $u"
    $foundW=$true
    break
  } catch {
    Write-Output "Failed wasm: $u -> $($_.Exception.Message)"
  }
}
if(-not $foundW){ Write-Output 'zbar.wasm not found in tried URLs.' }
