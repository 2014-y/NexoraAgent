$env:ELECTRON_RUN_AS_NODE = '1'
$electron = Join-Path $PSScriptRoot '..\node_modules\electron\dist\electron.exe'
$worker = Join-Path $PSScriptRoot '..\tts-worker.js'
$modelDir = Join-Path $env:USERPROFILE '.openclaw\voice-packs\piper-zh-chaowen'
$textFile = Join-Path $PSScriptRoot '..\.tmp-voice-test\sample.txt'
$outWav = Join-Path $env:TEMP 'tts-electron-test.wav'
if (Test-Path $outWav) { Remove-Item $outWav -Force }
& $electron $worker --model-dir $modelDir --text-file $textFile --out $outWav --sid 0 --speed 1.0
if (Test-Path $outWav) {
  $size = (Get-Item $outWav).Length
  Write-Output ("WAV_OK size=" + $size)
} else {
  Write-Output 'WAV_MISSING'
}
