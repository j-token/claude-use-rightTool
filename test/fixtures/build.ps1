$files = Get-ChildItem -Path src -Filter *.ts -Recurse
foreach ($f in $files) {
    npx esbuild $f.FullName --outdir=dist
}
Write-Host "Built $($files.Count) files"
