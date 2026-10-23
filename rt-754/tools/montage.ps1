# montage.ps1 OUT COLS SCALE FILE... : tile screenshots with their file names (evidence review only)
param([string]$Out, [int]$Cols, [double]$Scale, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Files)
Add-Type -AssemblyName System.Drawing
$ims = $Files | ForEach-Object { [System.Drawing.Image]::FromFile((Resolve-Path $_)) }
$w = [int]($ims[0].Width * $Scale); $h = [int]($ims[0].Height * $Scale); $rows = [math]::Ceiling($ims.Count / $Cols)
$m = New-Object System.Drawing.Bitmap ($Cols * $w), ($rows * ($h + 18)); $g = [System.Drawing.Graphics]::FromImage($m); $g.Clear([System.Drawing.Color]::White)
$f = New-Object System.Drawing.Font 'Arial', 9
for ($i = 0; $i -lt $ims.Count; $i++) { $x = ($i % $Cols) * $w; $y = [math]::Floor($i / $Cols) * ($h + 18)
  $g.DrawImage($ims[$i], $x, $y + 18, $w, $h); $g.DrawString((Split-Path $Files[$i] -Leaf), $f, [System.Drawing.Brushes]::Red, $x + 3, $y + 2); $g.DrawRectangle([System.Drawing.Pens]::Gray, $x, $y + 18, $w - 1, $h - 1) }
$m.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $ims | ForEach-Object { $_.Dispose() }; "montage $Out"
