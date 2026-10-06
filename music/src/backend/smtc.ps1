# Module Musique en cours : lit ce que joue Spotify dans les contrôles multimédias de Windows (SMTC),
# ceux qu'affiche le panneau du volume. Écrit une ligne JSON toutes les 500 ms sur la sortie standard :
#   { app, title, artist, album, status, position, duration, updated, cover? }   (temps en ms)
#   { app: null } quand Spotify n'est pas ouvert, { error } si Windows refuse la lecture.
# cover (PNG ou JPEG en base64) n'est envoyé qu'au changement de morceau, puis s'il change encore :
# Spotify publie parfois la pochette une seconde après le titre.
# Lancé par backend.js avec Windows PowerShell 5.1 (seule version qui charge les types WinRT sans module en plus).
# S'arrête de lui-même quand SceneCue ne lit plus sa sortie.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# attendre une opération asynchrone WinRT (IAsyncOperation<T>) depuis PowerShell
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$Manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$Props = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$StreamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
# PowerShell ne voit pas les méthodes du flux WinRT : on passe par la réflexion
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$md5 = [Security.Cryptography.MD5]::Create()

function Read-Cover($p) {
  if (-not $p.Thumbnail) { return $null }
  $s = $asStream.Invoke($null, @((Await ($p.Thumbnail.OpenReadAsync()) $StreamType)))
  try {
    $ms = New-Object IO.MemoryStream
    $s.CopyTo($ms)
    if ($ms.Length -gt 0) { return $ms.ToArray() } else { return $null }
  } finally { $s.Dispose() }
}

$mgr = Await ($Manager::RequestAsync()) $Manager
$key = $null    # morceau affiché (titre|artiste|album)
$hash = $null   # empreinte de la dernière pochette envoyée
$tries = 0      # lectures de pochette restantes pour ce morceau

while ($true) {
  $out = [ordered]@{ app = $null }
  try {
    $s = $mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'spotify' } | Select-Object -First 1
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) $Props
      $tl = $s.GetTimelineProperties()
      $out = [ordered]@{
        app = $s.SourceAppUserModelId
        title = $p.Title
        artist = $p.Artist
        album = $p.AlbumTitle
        status = [string]$s.GetPlaybackInfo().PlaybackStatus
        position = [long]$tl.Position.TotalMilliseconds
        duration = [long]($tl.EndTime - $tl.StartTime).TotalMilliseconds
        updated = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
      }
      $k = "$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"
      if ($k -ne $key) { $key = $k; $hash = $null; $tries = 6 }
      if ($tries -gt 0) {
        $tries--
        $bytes = Read-Cover $p
        $h = if ($bytes) { [BitConverter]::ToString($md5.ComputeHash($bytes)) } else { '' }
        if ($h -ne $hash) {
          $hash = $h
          $out.cover = if ($bytes) { [Convert]::ToBase64String($bytes) } else { $null }
        }
      }
    } else {
      $key = $null
    }
  } catch {
    $out = [ordered]@{ error = $_.Exception.Message }
  }
  # hors du try : si SceneCue a fermé le tube, l'écriture échoue et le script s'arrête
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 500
}
