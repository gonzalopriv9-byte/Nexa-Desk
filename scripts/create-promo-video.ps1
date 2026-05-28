param(
  [int]$Width = 1920,
  [int]$Height = 1080,
  [int]$Fps = 15,
  [double]$DurationSeconds = 48,
  [switch]$KeepFrames
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$AssetDir = Join-Path $RepoRoot 'assets'
$FrameDir = Join-Path $RepoRoot 'data\promo-frames'
$VideoPath = Join-Path $AssetDir 'nexadesk-promo-v13.mp4'
$PosterPath = Join-Path $AssetDir 'nexadesk-promo-v13-poster.png'
$LogoPath = Join-Path $AssetDir 'nexadesk-logo.png'

if (Test-Path $FrameDir) { Remove-Item -LiteralPath $FrameDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $FrameDir | Out-Null

$script:W = $Width
$script:H = $Height
$script:White = [System.Drawing.Color]::White
$script:Black = [System.Drawing.Color]::Black
$script:Muted = [System.Drawing.Color]::FromArgb(180, 210, 210, 210)
$script:Line = [System.Drawing.Color]::FromArgb(62, 255, 255, 255)
$script:Panel = [System.Drawing.Color]::FromArgb(235, 16, 16, 16)
$script:Panel2 = [System.Drawing.Color]::FromArgb(245, 28, 28, 28)
$script:Gold = [System.Drawing.Color]::FromArgb(255, 235, 200, 92)

$logo = if (Test-Path $LogoPath) { [System.Drawing.Image]::FromFile($LogoPath) } else { $null }
$fontTitle = New-Object System.Drawing.Font('Segoe UI', 78, [System.Drawing.FontStyle]::Bold)
$fontBig = New-Object System.Drawing.Font('Segoe UI', 52, [System.Drawing.FontStyle]::Bold)
$fontMed = New-Object System.Drawing.Font('Segoe UI', 34, [System.Drawing.FontStyle]::Bold)
$fontBody = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Regular)
$fontSmall = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Regular)
$fontMono = New-Object System.Drawing.Font('Consolas', 20, [System.Drawing.FontStyle]::Regular)

function Clamp01([double]$v) {
  if ($v -lt 0) { return 0 }
  if ($v -gt 1) { return 1 }
  return $v
}

function Ease([double]$v) {
  $x = Clamp01 $v
  return $x * $x * (3 - 2 * $x)
}

function AColor([System.Drawing.Color]$color, [double]$alpha) {
  return [System.Drawing.Color]::FromArgb([int](255 * (Clamp01 $alpha)), $color.R, $color.G, $color.B)
}

function Brush([System.Drawing.Color]$color, [double]$alpha = 1) {
  return New-Object System.Drawing.SolidBrush (AColor $color $alpha)
}

function PenC([System.Drawing.Color]$color, [double]$alpha = 1, [float]$width = 1) {
  return New-Object System.Drawing.Pen (AColor $color $alpha), $width
}

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function FillRound($g, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r, [System.Drawing.Color]$color, [double]$alpha = 1) {
  $path = RoundRect $x $y $w $h $r
  $brush = Brush $color $alpha
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

function StrokeRound($g, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r, [System.Drawing.Color]$color, [double]$alpha = 1, [float]$width = 1) {
  $path = RoundRect $x $y $w $h $r
  $pen = PenC $color $alpha $width
  $g.DrawPath($pen, $path)
  $pen.Dispose()
  $path.Dispose()
}

function Text($g, [string]$text, $font, [System.Drawing.Color]$color, [float]$x, [float]$y, [float]$w, [float]$h, [double]$alpha = 1, [string]$align = 'Near') {
  $brush = Brush $color $alpha
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::$align
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Near
  $fmt.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
  $rect = New-Object System.Drawing.RectangleF($x, $y, $w, $h)
  $g.DrawString($text, $font, $brush, $rect, $fmt)
  $fmt.Dispose()
  $brush.Dispose()
}

function DrawLogo($g, [float]$x, [float]$y, [float]$size, [double]$alpha = 1) {
  if ($script:logo) {
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $matrix = New-Object System.Drawing.Imaging.ColorMatrix
    $matrix.Matrix33 = [single](Clamp01 $alpha)
    $attrs.SetColorMatrix($matrix)
    $rect = New-Object System.Drawing.Rectangle([int]$x, [int]$y, [int]$size, [int]$size)
    $g.DrawImage($script:logo, $rect, 0, 0, $script:logo.Width, $script:logo.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    $attrs.Dispose()
    return
  }
  StrokeRound $g $x $y $size $size 18 $script:White $alpha 3
  Text $g 'N' $script:fontBig $script:White ($x + 12) ($y + 10) ($size - 24) ($size - 24) $alpha 'Center'
}

function DrawBackground($g, [double]$t) {
  $g.Clear($script:Black)
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, $script:W, $script:H)),
    [System.Drawing.Color]::FromArgb(255, 0, 0, 0),
    [System.Drawing.Color]::FromArgb(255, 22, 22, 22),
    25
  )
  $g.FillRectangle($bg, 0, 0, $script:W, $script:H)
  $bg.Dispose()

  $gridPen = PenC $script:White .09 1
  $offset = [int](($t * 24) % 120)
  for ($x = -120 + $offset; $x -lt $script:W + 120; $x += 120) { $g.DrawLine($gridPen, $x, 0, $x, $script:H) }
  for ($y = -120 + $offset; $y -lt $script:H + 120; $y += 120) { $g.DrawLine($gridPen, 0, $y, $script:W, $y) }
  $gridPen.Dispose()

  $glow = New-Object System.Drawing.Drawing2D.PathGradientBrush((RoundRect 360 130 1200 740 120))
  $glow.CenterColor = [System.Drawing.Color]::FromArgb(36, 255, 255, 255)
  $glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
  $g.FillRectangle($glow, 0, 0, $script:W, $script:H)
  $glow.Dispose()
}

function DrawHeader($g, [string]$label, [double]$alpha = 1) {
  DrawLogo $g 72 64 54 $alpha
  Text $g 'NEXADESK' $script:fontSmall $script:White 140 74 260 30 $alpha
  Text $g $label $script:fontSmall $script:Muted 140 104 620 34 $alpha
}

function DrawDashboardMock($g, [float]$x, [float]$y, [float]$w, [float]$h, [double]$p) {
  FillRound $g $x $y $w $h 34 $script:Panel .94
  StrokeRound $g $x $y $w $h 34 $script:White .18 2
  FillRound $g ($x + 24) ($y + 24) 250 ($h - 48) 24 ([System.Drawing.Color]::FromArgb(8, 18, 18)) .98
  DrawLogo $g ($x + 54) ($y + 54) 52 1
  Text $g 'NexaDesk' $script:fontBody $script:White ($x + 122) ($y + 62) 140 36 1
  $nav = @('Resumen','Servidores','Configuracion','Paneles','Premium','Logs')
  for ($i=0; $i -lt $nav.Count; $i++) {
    $ny = $y + 160 + $i * 58
    $active = if ($i -eq [Math]::Floor((Clamp01 $p) * 5.99)) { 1 } else { .45 }
    Text $g $nav[$i] $script:fontSmall $script:White ($x + 54) $ny 170 30 $active
  }

  $cx = $x + 310
  Text $g 'Centro de control para soporte con IA' $script:fontBig $script:White $cx ($y + 62) ($w - 350) 70 1
  Text $g 'Paneles, contexto, seguridad, premium y transcripciones en tiempo real.' $script:fontBody $script:Muted $cx ($y + 132) ($w - 420) 44 .92

  $cards = @(
    @('Tickets detectados','128'),
    @('Tiempo ahorrado','34h'),
    @('NexaScore','96%'),
    @('Staff escalado','14')
  )
  for ($i=0; $i -lt $cards.Count; $i++) {
    $cardX = $cx + ($i % 4) * (($w - 380) / 4)
    FillRound $g $cardX ($y + 210) 190 104 18 ([System.Drawing.Color]::FromArgb(34,34,34)) (.82 + .1 * [Math]::Sin($p * 6.28 + $i))
    StrokeRound $g $cardX ($y + 210) 190 104 18 $script:White .17 1
    Text $g $cards[$i][1] $script:fontMed $script:White ($cardX + 18) ($y + 226) 150 42 1
    Text $g $cards[$i][0] $script:fontSmall $script:Muted ($cardX + 18) ($y + 276) 150 28 1
  }

  FillRound $g $cx ($y + 360) ($w - 360) 260 24 ([System.Drawing.Color]::FromArgb(22,22,22)) .92
  StrokeRound $g $cx ($y + 360) ($w - 360) 260 24 $script:White .16 1
  Text $g 'Configuracion inteligente' $script:fontMed $script:White ($cx + 28) ($y + 386) 500 44 1
  $rows = @('Categoria de tickets detectada', 'Rol staff configurado', 'Prompt IA con contexto', 'XN Tickets compatible')
  for ($i=0; $i -lt $rows.Count; $i++) {
    $ry = $y + 456 + $i * 40
    $rowActive = $p -gt ($i * .18)
    $dotAlpha = if ($rowActive) { 1 } else { .22 }
    $rowAlpha = if ($rowActive) { .95 } else { .32 }
    FillRound $g ($cx + 30) $ry 22 22 11 $script:White $dotAlpha
    Text $g $rows[$i] $script:fontSmall $script:White ($cx + 66) ($ry - 4) 440 32 $rowAlpha
  }
}

function DrawDiscordMock($g, [float]$x, [float]$y, [float]$w, [float]$h, [double]$p) {
  FillRound $g $x $y $w $h 34 ([System.Drawing.Color]::FromArgb(18,18,22)) .98
  StrokeRound $g $x $y $w $h 34 $script:White .16 2
  Text $g '# ticket-128' $script:fontMed $script:White ($x + 34) ($y + 26) 420 48 1
  $messages = @(
    @('Ticket King / XN Tickets', 'Ticket Abierto: @usuario ha creado un nuevo ticket.', .55),
    @('NexaDesk', 'Hola, soy NexaDesk. He detectado este ticket y voy a ayudarte aqui.', 1),
    @('Usuario', 'Tengo un problema con una compra. No se que hacer.', .82),
    @('NexaDesk', 'Entendido. Voy a revisar el contexto del servidor y te pido solo lo necesario.', 1),
    @('Usuario', 'Tambien tengo captura del error.', .82),
    @('NexaDesk', '@Staff caso escalado: compra + prueba visual. Resumen preparado.', 1)
  )
  $visible = [Math]::Floor((Clamp01 $p) * ($messages.Count + .8))
  for ($i=0; $i -lt $messages.Count; $i++) {
    if ($i -gt $visible) { continue }
    $m = $messages[$i]
    $my = $y + 112 + $i * 92
    $isBot = $m[0] -eq 'NexaDesk'
    $bubbleColor = if ($isBot) { [System.Drawing.Color]::FromArgb(35,35,35) } else { [System.Drawing.Color]::FromArgb(24,24,24) }
    $bubbleStroke = if ($isBot) { .18 } else { .08 }
    $authorColor = if ($isBot) { $script:White } else { $script:Muted }
    FillRound $g ($x + 34) $my ($w - 68) 72 18 $bubbleColor .94
    StrokeRound $g ($x + 34) $my ($w - 68) 72 18 $script:White $bubbleStroke 1
    Text $g $m[0] $script:fontSmall $authorColor ($x + 58) ($my + 10) 260 26 1
    Text $g $m[1] $script:fontSmall $script:White ($x + 58) ($my + 38) ($w - 120) 28 $m[2]
  }
}

function DrawFlow($g, [double]$p) {
  $items = @(
    @('Usuario abre ticket','Panel propio o bot externo'),
    @('NexaDesk entra','Lee contexto y respuestas previas'),
    @('IA atiende','Pregunta solo lo necesario'),
    @('Escala si hace falta','Staff recibe resumen claro'),
    @('Transcripcion','Dashboard + MD al usuario'),
    @('Crecimiento','Reviews, NexaScore y aprendizaje')
  )
  $startX = 160
  $y = 450
  for ($i=0; $i -lt $items.Count; $i++) {
    $x = $startX + $i * 290
    $active = Clamp01 (($p * $items.Count) - $i)
    FillRound $g $x $y 235 138 26 $script:Panel2 (.45 + .45 * $active)
    StrokeRound $g $x $y 235 138 26 $script:White (.12 + .45 * $active) 2
    Text $g $items[$i][0] $script:fontSmall $script:White ($x + 20) ($y + 28) 195 30 (.45 + .55 * $active) 'Center'
    Text $g $items[$i][1] $script:fontSmall $script:Muted ($x + 20) ($y + 70) 195 44 (.35 + .55 * $active) 'Center'
    if ($i -lt $items.Count - 1) {
      $pen = PenC $script:White (.18 + .55 * (Clamp01 (($p * $items.Count) - $i - .45))) 4
      $g.DrawLine($pen, $x + 235, $y + 69, $x + 290, $y + 69)
      $pen.Dispose()
    }
  }
}

function DrawFeatureGrid($g, [double]$p) {
  $features = @(
    @('Compatibilidad total','Ticket King, XN Tickets, Guild Manager'),
    @('Staff Copilot','Resumen, riesgo y siguiente accion'),
    @('Security Guard','Flood, links, XN Protect y anti-nuke'),
    @('Voz Pro','STT/TTS + transcript'),
    @('Modo examen','Postulaciones corregidas con IA'),
    @('Growth Engine','Reviews, afiliados y Churn Radar')
  )
  for ($i=0; $i -lt $features.Count; $i++) {
    $row = [Math]::Floor($i / 3)
    $col = $i % 3
    $x = 210 + $col * 500
    $y = 350 + $row * 210
    $a = Clamp01 (($p * 8) - $i)
    FillRound $g $x $y 430 154 24 $script:Panel2 (.25 + .65 * $a)
    $featureColor = if ($i -eq 0) { $script:Gold } else { $script:White }
    StrokeRound $g $x $y 430 154 24 $featureColor (.12 + .5 * $a) 2
    Text $g $features[$i][0] $script:fontMed $featureColor ($x + 26) ($y + 28) 380 42 $a
    Text $g $features[$i][1] $script:fontSmall $script:Muted ($x + 26) ($y + 86) 370 44 $a
  }
}

function DrawFrame([int]$frame) {
  $t = $frame / $Fps
  $bmp = New-Object System.Drawing.Bitmap($script:W, $script:H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  DrawBackground $g $t

  if ($t -lt 6) {
    $p = Ease ($t / 6)
    DrawLogo $g (820 - 80 * (1 - $p)) 270 260 (0.25 + .75 * $p)
    Text $g 'NexaDesk' $fontTitle $script:White 520 570 880 90 $p 'Center'
    Text $g 'AI support for every ticket' $fontMed $script:Muted 520 666 880 54 $p 'Center'
    Text $g 'No cambies tu bot de tickets. Hazlo inteligente.' $fontBody $script:White 520 744 880 44 (Clamp01 (($t - 2) / 2)) 'Center'
  } elseif ($t -lt 14) {
    $p = Ease (($t - 6) / 8)
    DrawHeader $g 'Compatibilidad sin migraciones' 1
    Text $g 'Tu sistema actual sigue. NexaDesk se pone encima.' $fontBig $script:White 120 170 1200 70 1
    Text $g 'Ticket King, XN Tickets, Guild Manager o paneles propios: el ticket se abre igual, la IA trabaja dentro.' $fontBody $script:Muted 120 250 1280 80 1
    DrawFlow $g $p
  } elseif ($t -lt 24) {
    $p = Ease (($t - 14) / 10)
    DrawHeader $g 'Dashboard profesional' 1
    DrawDashboardMock $g 180 180 1560 760 $p
  } elseif ($t -lt 34) {
    $p = Ease (($t - 24) / 10)
    DrawHeader $g 'En el ticket, donde importa' 1
    Text $g 'NexaDesk responde, pide contexto real y llama al staff cuando toca.' $fontBig $script:White 120 160 1160 70 1
    DrawDiscordMock $g 260 270 1400 670 $p
  } elseif ($t -lt 42) {
    $p = Ease (($t - 34) / 8)
    DrawHeader $g 'Funciones que hacen que los servidores se queden' 1
    Text $g 'Premium convierte soporte en experiencia, seguridad y crecimiento.' $fontBig $script:White 180 185 1280 70 1
    DrawFeatureGrid $g $p
  } else {
    $p = Ease (($t - 42) / 6)
    DrawLogo $g 780 230 360 $p
    Text $g 'NexaDesk' $fontTitle $script:White 500 620 920 92 $p 'Center'
    Text $g 'Soporte rapido. Escalados limpios. Humano cuando importa.' $fontMed $script:Muted 340 720 1240 58 $p 'Center'
    Text $g 'https://nexa-desk.onrender.com  |  discord.gg/vVXbq7ePEZ' $fontBody $script:White 360 835 1200 44 (Clamp01 (($t - 44) / 2)) 'Center'
  }

  $scanAlpha = .16 * [Math]::Max(0, [Math]::Sin($t * 2.2))
  $scanBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, $script:W, $script:H)),
    (AColor $script:White 0),
    (AColor $script:White $scanAlpha),
    12
  )
  $g.FillRectangle($scanBrush, 0, 0, $script:W, $script:H)
  $scanBrush.Dispose()

  $file = Join-Path $FrameDir ('frame_{0:D5}.png' -f $frame)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($frame -eq [int]($Fps * 5.2)) {
    $bmp.Save($PosterPath, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $g.Dispose()
  $bmp.Dispose()
}

$totalFrames = [int]($Fps * $DurationSeconds)
Write-Host "Generating $totalFrames frames..."
for ($i = 0; $i -lt $totalFrames; $i++) {
  DrawFrame $i
  if ($i % 60 -eq 0) { Write-Host "Frame $i / $totalFrames" }
}

Write-Host "Encoding video..."
& ffmpeg -y -framerate $Fps -i (Join-Path $FrameDir 'frame_%05d.png') -vf "format=yuv420p" -c:v libx264 -preset medium -crf 18 -movflags +faststart $VideoPath
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed with exit code $LASTEXITCODE" }

if (-not $KeepFrames) {
  Remove-Item -LiteralPath $FrameDir -Recurse -Force
}

Write-Host "Video: $VideoPath"
Write-Host "Poster: $PosterPath"

if ($logo) { $logo.Dispose() }
$fontTitle.Dispose()
$fontBig.Dispose()
$fontMed.Dispose()
$fontBody.Dispose()
$fontSmall.Dispose()
$fontMono.Dispose()
