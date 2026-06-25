$ErrorActionPreference = 'Stop'

$repo = 'Zam6969/FanslyLeaderboardOverlay'
$branch = 'main'
$timeoutSeconds = 8
$githubUrl = "https://github.com/$repo"
$headers = @{
  'Accept' = 'application/vnd.github+json'
  'User-Agent' = 'FanslyLeaderboardOverlay-UpdateCheck'
}

function Write-UpdateLine {
  param([string]$Message)
  Write-Host "[update] $Message"
}

function Get-LocalPackageVersion {
  $packagePath = Join-Path (Get-Location) 'package.json'
  if (-not (Test-Path -LiteralPath $packagePath)) {
    return $null
  }

  try {
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    return [string]$package.version
  } catch {
    return $null
  }
}

function Convert-ToVersion {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  try {
    return [version]$Value
  } catch {
    return $null
  }
}

function Get-GitCommand {
  $command = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $command = Get-Command git -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

function Test-IsGitCheckout {
  return Test-Path -LiteralPath (Join-Path (Get-Location) '.git')
}

function Get-GitOutput {
  param(
    [string]$Git,
    [string[]]$Arguments
  )

  $output = & $Git @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  return ($output -join "`n").Trim()
}

try {
  Write-UpdateLine 'Checking GitHub for updates...'

  $commitUrl = "https://api.github.com/repos/$repo/commits/$branch"
  $latestCommit = Invoke-RestMethod -Uri $commitUrl -Headers $headers -TimeoutSec $timeoutSeconds
  $remoteSha = [string]$latestCommit.sha

  $git = Get-GitCommand
  if ($git -and (Test-IsGitCheckout)) {
    $localSha = Get-GitOutput -Git $git -Arguments @('rev-parse', 'HEAD')
    if ($localSha -and $remoteSha) {
      $localShort = $localSha.Substring(0, [Math]::Min(7, $localSha.Length))
      $remoteShort = $remoteSha.Substring(0, [Math]::Min(7, $remoteSha.Length))

      if ($localSha -eq $remoteSha) {
        Write-UpdateLine "Up to date ($localShort)."
      } else {
        Write-UpdateLine "Update available: local $localShort, GitHub $remoteShort."
        Write-UpdateLine "Run this from the app folder to update: git pull --ff-only origin $branch"
      }
      exit 0
    }
  }

  $localVersionText = Get-LocalPackageVersion
  $remotePackageUrl = "https://raw.githubusercontent.com/$repo/$branch/package.json"
  $remotePackage = Invoke-RestMethod -Uri $remotePackageUrl -TimeoutSec $timeoutSeconds
  $remoteVersionText = [string]$remotePackage.version
  $localVersion = Convert-ToVersion $localVersionText
  $remoteVersion = Convert-ToVersion $remoteVersionText

  if ($localVersion -and $remoteVersion) {
    if ($remoteVersion -gt $localVersion) {
      Write-UpdateLine "Update available: local v$localVersionText, GitHub v$remoteVersionText."
      Write-UpdateLine "Download the latest files from $githubUrl"
    } else {
      Write-UpdateLine "No newer packaged version found (v$localVersionText)."
    }
  } elseif ($remoteSha) {
    $remoteShort = $remoteSha.Substring(0, [Math]::Min(7, $remoteSha.Length))
    Write-UpdateLine "Latest GitHub build is $remoteShort. Open $githubUrl to compare or download."
  } else {
    Write-UpdateLine 'Could not compare local files to GitHub.'
  }
} catch {
  Write-UpdateLine "Could not check for updates: $($_.Exception.Message)"
  Write-UpdateLine 'Starting anyway.'
}

exit 0
