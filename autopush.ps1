# Автоматическая загрузка D:\CRM на GitHub.
# Запуск вручную:  powershell -ExecutionPolicy Bypass -File D:\CRM\autopush.ps1
# Делает commit всех изменений и push в origin/main. Если изменений нет — ничего не делает.

$ErrorActionPreference = 'Stop'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
Set-Location $PSScriptRoot

git add -A
$changes = git status --porcelain
if (-not $changes) {
    Write-Output "Нет изменений — загружать нечего."
    exit 0
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
git commit -m "Auto-commit $stamp"
git push -u origin main
Write-Output "Загружено на GitHub: $stamp"
