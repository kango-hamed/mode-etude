# Publie la version du manifeste : signature Mozilla (non listée), Release GitHub avec le .xpi,
# puis mise à jour de updates.json pour que Firefox installe la nouvelle version tout seul.
#
# Avant : augmente "version" dans manifest.json, commite, et définis tes clés AMO dans ce terminal :
#   $env:WEB_EXT_API_KEY = "user:..." ; $env:WEB_EXT_API_SECRET = "..."
# Puis, depuis la racine du projet :  .\scripts\release.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Fail($msg) { Write-Host "`n$msg" -ForegroundColor Red; exit 1 }
# Lance une commande externe en silence et dit si elle a réussi. Sous PowerShell 5.1, rediriger la sortie
# d'erreur d'un programme avec 'Stop' en fait une erreur bloquante : on repasse donc en 'Continue' ici.
function Test-Native([scriptblock]$cmd) { $ErrorActionPreference = 'Continue'; & $cmd *> $null; return ($LASTEXITCODE -eq 0) }

if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET) { Fail 'Clés AMO absentes : définis $env:WEB_EXT_API_KEY et $env:WEB_EXT_API_SECRET dans ce terminal.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'GitHub CLI introuvable : winget install GitHub.cli, puis gh auth login.' }
if (git status --porcelain) { Fail 'Des modifications ne sont pas commitées : commite-les avant de publier.' }

$manifest = Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$id = $manifest.browser_specific_settings.gecko.id
$tag = "v$version"
$repo = gh repo view --json nameWithOwner -q .nameWithOwner
if (-not $repo) { Fail 'Dépôt GitHub introuvable (git remote origin).' }

if (Test-Native { gh release view $tag }) { Fail "La Release $tag existe déjà : augmente la version dans manifest.json." }

Write-Host "`n1/4 Signature de $version par Mozilla (quelques minutes)..." -ForegroundColor Cyan
npx --yes web-ext sign --channel=unlisted
if ($LASTEXITCODE -ne 0) { Fail 'La signature a échoué (voir le message ci-dessus).' }
$signed = Get-ChildItem web-ext-artifacts -Filter "*-$version.xpi" | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $signed) { Fail "Fichier signé introuvable dans web-ext-artifacts pour $version." }
$xpi = "web-ext-artifacts\mode-etude-$version.xpi"
Copy-Item $signed.FullName $xpi -Force

Write-Host "2/4 Tag $tag..." -ForegroundColor Cyan
if (-not (Test-Native { git rev-parse -q --verify "refs/tags/$tag" })) { git tag -a $tag -m "Mode Étude $tag" }
git push origin main --follow-tags
git push origin $tag

Write-Host "3/4 Release GitHub..." -ForegroundColor Cyan
$notes = git log -1 --format=%B $tag
gh release create $tag $xpi --title "Mode Étude $version" --notes "$notes"
if ($LASTEXITCODE -ne 0) { Fail 'Création de la Release impossible.' }

Write-Host "4/4 updates.json..." -ForegroundColor Cyan
$link = "https://github.com/$repo/releases/download/$tag/mode-etude-$version.xpi"
$hash = 'sha256:' + (Get-FileHash $xpi -Algorithm SHA256).Hash.ToLower()
$updates = if (Test-Path updates.json) { Get-Content updates.json -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$list = @()
if ($updates -and $updates.addons.$id) { $list = @($updates.addons.$id.updates | Where-Object { $_.version -ne $version }) }
$list += [pscustomobject]@{ version = $version; update_link = $link; update_hash = $hash }
$doc = [pscustomobject]@{ addons = [pscustomobject]@{ $id = [pscustomobject]@{ updates = $list } } }
$json = $doc | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path (Get-Location) 'updates.json'), $json + "`n", (New-Object Text.UTF8Encoding $false))
git add updates.json
git commit -m "updates.json : $version"
git push origin main

Write-Host "`nPublié : $tag. Firefox proposera la mise à jour à son prochain contrôle (environ une fois par jour)." -ForegroundColor Green
Write-Host "Pour forcer : about:addons → roue dentée → Rechercher des mises à jour."
