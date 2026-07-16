#Requires -RunAsAdministrator
<#
    Deploy automatico do catraca-api no PC da catraca (Windows + NSSM).
    Substitui o passo-a-passo manual: para o servico, atualiza o codigo,
    reconstroi e religa. Se qualquer passo falhar, ABORTA sem subir codigo
    quebrado e tenta religar a versao anterior (a catraca nunca fica no ar
    com build pela metade).

    Como rodar (PowerShell como Administrador):
        powershell -ExecutionPolicy Bypass -File C:\catraca-api\deploy.ps1
#>

$ErrorActionPreference = "Stop"
$repo = "C:\catraca-api"
$service = "CatracaApi"

function Abortar($passo) {
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n[ERRO] Falhou em: $passo (codigo $LASTEXITCODE)" -ForegroundColor Red
        Write-Host "Deploy abortado. Religando o servico com a versao anterior..." -ForegroundColor Yellow
        nssm start $service
        exit 1
    }
}

Set-Location $repo

Write-Host "==> Parando o servico" -ForegroundColor Cyan
nssm stop $service
# Da um tempo pro Windows liberar os arquivos do Prisma (senao 'prisma
# generate' falha com EPERM ... rename query_engine-windows.dll).
Start-Sleep -Seconds 3

Write-Host "==> git pull" -ForegroundColor Cyan
git pull
Abortar "git pull"

Write-Host "==> npm install" -ForegroundColor Cyan
npm install
Abortar "npm install"

Write-Host "==> prisma generate" -ForegroundColor Cyan
npx prisma generate
Abortar "prisma generate"

Write-Host "==> prisma db push" -ForegroundColor Cyan
npx prisma db push
Abortar "prisma db push"

Write-Host "==> build" -ForegroundColor Cyan
npm run build
Abortar "npm run build"

Write-Host "==> Iniciando o servico" -ForegroundColor Cyan
nssm start $service
Start-Sleep -Seconds 4
nssm status $service

Write-Host "`n==> Health check" -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "http://localhost:3001/health" -TimeoutSec 10
    Write-Host ("OK: " + ($health | ConvertTo-Json -Compress)) -ForegroundColor Green
    Write-Host "`nDeploy concluido com sucesso." -ForegroundColor Green
} catch {
    Write-Host "[AVISO] /health nao respondeu ainda. Confira os logs:" -ForegroundColor Yellow
    Write-Host "    Get-Content C:\catraca-api\logs\err.log -Tail 30" -ForegroundColor Yellow
}
