param(
  [string]$Title = "Antigravity",
  [string]$Summary = "Tarea finalizada",
  [string]$Detail = "",
  [string]$LogoPath = "",
  [string]$Kind = "done"
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System.Windows.Forms;
public class NoFocusToastForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
}
"@

$wav = if ($Kind -eq "waiting") { "C:\Windows\Media\Windows Notify Messaging.wav" } else { "C:\Windows\Media\Windows Notify Calendar.wav" }
if (Test-Path $wav) {
  try { (New-Object System.Media.SoundPlayer $wav).Play() } catch { [System.Media.SystemSounds]::Asterisk.Play() }
} else {
  [System.Media.SystemSounds]::Asterisk.Play()
}

$accent = if ($Kind -eq "waiting") { [System.Drawing.Color]::FromArgb(59, 130, 246) } else { [System.Drawing.Color]::FromArgb(16, 185, 129) }
$bg = [System.Drawing.Color]::FromArgb(17, 19, 24)
$fgWhite = [System.Drawing.Color]::FromArgb(241, 245, 249)
$fgMuted = [System.Drawing.Color]::FromArgb(148, 163, 184)

$form = New-Object NoFocusToastForm
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.BackColor = $bg
$form.Width = 370
$form.Height = 96

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($wa.Right - $form.Width - 16), ($wa.Bottom - $form.Height - 16))

$bar = New-Object System.Windows.Forms.Panel
$bar.BackColor = $accent
$bar.Bounds = New-Object System.Drawing.Rectangle(0, 0, 5, $form.Height)
$form.Controls.Add($bar)

$textX = 16
if ($LogoPath -and (Test-Path $LogoPath)) {
  $pic = New-Object System.Windows.Forms.PictureBox
  $pic.Bounds = New-Object System.Drawing.Rectangle(14, 22, 44, 44)
  $pic.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
  $pic.Image = [System.Drawing.Image]::FromFile($LogoPath)
  $form.Controls.Add($pic)
  $textX = 68
}

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = $Title
$lblTitle.ForeColor = $fgWhite
$lblTitle.Font = New-Object System.Drawing.Font("Segoe UI", 10.5, [System.Drawing.FontStyle]::Bold)
$lblTitle.Bounds = New-Object System.Drawing.Rectangle($textX, 12, ($form.Width - $textX - 60), 22)
$form.Controls.Add($lblTitle)

$lblTag = New-Object System.Windows.Forms.Label
$lblTag.Text = "/deck"
$lblTag.ForeColor = $fgMuted
$lblTag.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$lblTag.TextAlign = [System.Drawing.ContentAlignment]::TopRight
$lblTag.Bounds = New-Object System.Drawing.Rectangle(($form.Width - 56), 14, 44, 18)
$form.Controls.Add($lblTag)

$lblSum = New-Object System.Windows.Forms.Label
$lblSum.Text = $Summary
$lblSum.ForeColor = $accent
$lblSum.Font = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Bold)
$lblSum.Bounds = New-Object System.Drawing.Rectangle($textX, 36, ($form.Width - $textX - 12), 20)
$form.Controls.Add($lblSum)

$lblDet = New-Object System.Windows.Forms.Label
$lblDet.Text = $Detail
$lblDet.ForeColor = $fgMuted
$lblDet.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$lblDet.Bounds = New-Object System.Drawing.Rectangle($textX, 58, ($form.Width - $textX - 12), 28)
$form.Controls.Add($lblDet)

$dismiss = { $form.Close() }
foreach ($ctrl in @($form, $bar, $lblTitle, $lblTag, $lblSum, $lblDet)) {
  $ctrl.Add_Click($dismiss)
}
if ($pic) { $pic.Add_Click($dismiss) }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
