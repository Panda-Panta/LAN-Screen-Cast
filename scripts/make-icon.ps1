$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assetDir = Join-Path $taskRoot 'assets'
New-Item -ItemType Directory -Path $assetDir -Force | Out-Null
$images = @()
foreach ($size in @(256, 48, 32, 16)) {
    $bitmap = New-Object Drawing.Bitmap($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([Drawing.Color]::FromArgb(255, 19, 103, 197))
    $pen = New-Object Drawing.Pen([Drawing.Color]::White, ($size / 23))
    $graphics.DrawRectangle($pen, [single]($size * .17), [single]($size * .23), [single]($size * .49), [single]($size * .38))
    $graphics.DrawLine($pen, [single]($size * .415), [single]($size * .62), [single]($size * .415), [single]($size * .76))
    $graphics.DrawLine($pen, [single]($size * .28), [single]($size * .77), [single]($size * .55), [single]($size * .77))
    $graphics.DrawArc($pen, [single]($size * .57), [single]($size * .20), [single]($size * .24), [single]($size * .44), [single](-65), [single]130)
    $stream = New-Object IO.MemoryStream
    $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    $images += ,@{ Size=$size; Bytes=$stream.ToArray() }
    if ($size -eq 256) { $bitmap.Save((Join-Path $assetDir 'icon.png'), [Drawing.Imaging.ImageFormat]::Png) }
    $stream.Dispose(); $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
$output = [IO.File]::Create((Join-Path $assetDir 'icon.ico'))
$writer = New-Object IO.BinaryWriter($output)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($entry in $images) {
    $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$entry.Bytes.Length); $writer.Write([uint32]$offset)
    $offset += $entry.Bytes.Length
}
foreach ($entry in $images) { $writer.Write([byte[]]$entry.Bytes) }
$writer.Dispose(); $output.Dispose()
Write-Output 'Generated app icon.'
