try {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } |
    Select-Object Name, @{N='Culture';E={$_.Culture.Name}}, Gender |
    Format-Table -AutoSize
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
}
