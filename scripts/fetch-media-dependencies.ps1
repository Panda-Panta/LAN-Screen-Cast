[CmdletBinding()]
param(
    [switch]$VerifyOnly,
    [switch]$Offline,
    [switch]$UseCachedBuild,
    [string]$ToolchainPath = 'D:\Tools\mingw64',
    [string]$BashPath = 'C:\Program Files\Git\bin\bash.exe',
    [string]$CmakePath = 'C:\Program Files\CMake\bin\cmake.exe',
    [ValidateRange(1, 32)][int]$Jobs = 8
)

$ErrorActionPreference = 'Stop'
$taskProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskMediaRoot = Join-Path $taskProjectRoot 'vendor\media'
$taskCacheRoot = Join-Path $taskProjectRoot '.cache\media-dependencies'
$taskManifestPath = Join-Path $taskMediaRoot 'manifest.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Test-MediaManifest {
    $mediaRootItem = Get-Item -LiteralPath $taskMediaRoot
    if ($mediaRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native dependency root must not be a reparse point.' }
    if (-not (Test-Path -LiteralPath $taskManifestPath -PathType Leaf)) { throw 'Native dependency manifest is missing.' }
    $taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw | ConvertFrom-Json
    if ($taskManifest.schemaVersion -ne 1 -or $taskManifest.dependencies.Count -lt 1 -or $taskManifest.files.Count -lt 1) {
        throw 'Invalid native dependency manifest.'
    }
    $expectedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($file in $taskManifest.files) {
        if ($file.path -notmatch '^(bin|licenses|sources)/[^\\:]+$' -or $file.path -match '(^|/)\.{1,2}(/|$)|//|/$' -or $file.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw 'Unsafe or invalid native dependency manifest entry.'
        }
        if (-not $expectedPaths.Add([string]$file.path)) { throw "Duplicate manifest path: $($file.path)" }
        $absolute = Join-Path $taskMediaRoot $file.path
        $actual = Get-Item -LiteralPath $absolute
        if ($actual.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Native symlink is not allowed: $($file.path)" }
        if ($actual.Length -ne $file.size -or (Get-Sha256 $absolute) -ne $file.sha256) { throw "Native dependency hash mismatch: $($file.path)" }
    }
    foreach ($item in Get-ChildItem -LiteralPath $taskMediaRoot -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native dependencies must not contain reparse points.' }
        if ($item.PSIsContainer -or $item.FullName -eq $taskManifestPath) { continue }
        $relative = $item.FullName.Substring($taskMediaRoot.Length + 1).Replace('\', '/')
        if (-not $expectedPaths.Contains($relative)) { throw "Unlisted native dependency: $relative" }
    }
    Write-Output "Verified $($taskManifest.files.Count) native files; manifest SHA256 $(Get-Sha256 $taskManifestPath)"
}

if ($VerifyOnly) { Test-MediaManifest; return }

New-Item -ItemType Directory -Force -Path $taskCacheRoot,(Join-Path $taskMediaRoot 'bin'),(Join-Path $taskMediaRoot 'licenses'),(Join-Path $taskMediaRoot 'sources') | Out-Null

function Get-VerifiedArchive([string]$Name, [string]$Url, [string]$Sha256) {
    if ($Name -match '[\\/:]' -or $Sha256 -notmatch '^[0-9a-f]{64}$' -or $Url -notmatch '^https://') { throw 'Invalid pinned archive definition.' }
    $target = Join-Path $taskCacheRoot $Name
    if (Test-Path -LiteralPath $target) {
        if ((Get-Sha256 $target) -ne $Sha256) { throw "Cached archive SHA256 mismatch: $Name" }
        return $target
    }
    if ($Offline) { throw "Offline archive is missing: $Name" }
    $temporary = $target + '.' + [Guid]::NewGuid().ToString('N') + '.download'
    & curl.exe --fail --location --retry 3 --max-time 180 --silent --show-error --output $temporary $Url
    if ($LASTEXITCODE -ne 0) { throw "Official dependency download failed: $Name" }
    if ((Get-Sha256 $temporary) -ne $Sha256) { throw "Downloaded archive SHA256 mismatch: $Name" }
    Move-Item -LiteralPath $temporary -Destination $target
    return $target
}

function Copy-ArchiveEntry([string]$ArchivePath, [string]$EntryName, [string]$RelativeTarget) {
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entry = $archive.GetEntry($EntryName)
        if (-not $entry) { throw "Archive entry is absent: $EntryName" }
        $target = Join-Path $taskMediaRoot $RelativeTarget
        New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($target)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    } finally { $archive.Dispose() }
}

function Expand-PinnedSource([string]$ArchivePath, [string]$ExpectedRoot) {
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            if (-not $entry.FullName.StartsWith($ExpectedRoot + '/', [StringComparison]::Ordinal) -or $entry.FullName -match '(^|/)\.\.(/|$)|[\\:]') {
                throw 'Unsafe pinned source ZIP path.'
            }
            if ($entry.FullName.EndsWith('/')) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $taskCacheRoot $entry.FullName))
            if (-not $target.StartsWith($taskCacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source extraction escaped the project cache.' }
            New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($target)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally { $archive.Dispose() }
}

$mediaMtxArchiveHash = 'a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467'
$mediaMtxArchive = Get-VerifiedArchive 'mediamtx_v1.21.2_windows_amd64.zip' 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_windows_amd64.zip' $mediaMtxArchiveHash
$mediaMtxChecksums = Get-VerifiedArchive 'mediamtx-checksums.sha256' 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/checksums.sha256' 'dea2c0c398ddf7c28a7d55f084be45555ad88a10ff920b299812f47e0ae8caba'
$checksumLine = Get-Content -LiteralPath $mediaMtxChecksums | Where-Object { $_ -match ' \*mediamtx_v1\.21\.2_windows_amd64\.zip$' }
if ($checksumLine -ne ($mediaMtxArchiveHash + ' *mediamtx_v1.21.2_windows_amd64.zip')) { throw 'MediaMTX official checksum does not match the release digest.' }
Copy-ArchiveEntry $mediaMtxArchive 'mediamtx.exe' 'bin/mediamtx.exe'
Copy-ArchiveEntry $mediaMtxArchive 'LICENSE' 'licenses/mediamtx-LICENSE.txt'
Copy-Item -LiteralPath $mediaMtxChecksums -Destination (Join-Path $taskMediaRoot 'licenses\mediamtx-checksums.sha256') -Force

$sourceDefinitions = @(
    @{ name = 'FFmpeg-46d899d7a02bc63237472cc4897258d5ddf274ac.zip'; root = 'FFmpeg-46d899d7a02bc63237472cc4897258d5ddf274ac'; url = 'https://codeload.github.com/FFmpeg/FFmpeg/zip/46d899d7a02bc63237472cc4897258d5ddf274ac'; sha = 'a133a3bb8317ec5357605a356df181d24a4f00347e9f7f6cbaea9f678f59d57d' },
    @{ name = 'nv-codec-headers-ced4f8eba3ba5dd431932cba17928f0dffdaeb2b.zip'; root = 'nv-codec-headers-ced4f8eba3ba5dd431932cba17928f0dffdaeb2b'; url = 'https://codeload.github.com/FFmpeg/nv-codec-headers/zip/ced4f8eba3ba5dd431932cba17928f0dffdaeb2b'; sha = '08cbb5b23676db26ca1cda581f0d6c37c63c43a57e3ee055ba1a45d35da3410a' },
    @{ name = 'kvazaar-2b06691bb5844404c0e703f12a5d7b0fee914ec7.zip'; root = 'kvazaar-2b06691bb5844404c0e703f12a5d7b0fee914ec7'; url = 'https://codeload.github.com/ultravideo/kvazaar/zip/2b06691bb5844404c0e703f12a5d7b0fee914ec7'; sha = '8d29a6e3ce99a765f98e56239f92c94f21afce5b7c160cea26098bcb4dff0076' },
    @{ name = 'mediamtx-914e39535ece709919ac325aaeed98d394ed9093.zip'; root = 'mediamtx-914e39535ece709919ac325aaeed98d394ed9093'; url = 'https://codeload.github.com/bluenviron/mediamtx/zip/914e39535ece709919ac325aaeed98d394ed9093'; sha = '442e4e0024951ced8b591f895b10309efc48c37af3816fa856c16c57d05697cf' }
)
foreach ($definition in $sourceDefinitions) {
    $archivePath = Get-VerifiedArchive $definition.name $definition.url $definition.sha
    Copy-Item -LiteralPath $archivePath -Destination (Join-Path $taskMediaRoot ('sources\' + $definition.name)) -Force
    if (-not $UseCachedBuild -and $definition.root -notmatch '^mediamtx-') { Expand-PinnedSource $archivePath $definition.root }
}
$ffmpegSourceDefinition = $sourceDefinitions[0]
$nvSourceDefinition = $sourceDefinitions[1]
$kvSourceDefinition = $sourceDefinitions[2]
Copy-ArchiveEntry (Join-Path $taskCacheRoot $ffmpegSourceDefinition.name) ($ffmpegSourceDefinition.root + '/COPYING.LGPLv2.1') 'licenses/ffmpeg-LICENSE.txt'
Copy-ArchiveEntry (Join-Path $taskCacheRoot $ffmpegSourceDefinition.name) ($ffmpegSourceDefinition.root + '/LICENSE.md') 'licenses/ffmpeg-LICENSE.md'
Copy-ArchiveEntry (Join-Path $taskCacheRoot $kvSourceDefinition.name) ($kvSourceDefinition.root + '/LICENSE') 'licenses/kvazaar-LICENSE.txt'
Copy-ArchiveEntry (Join-Path $taskCacheRoot $kvSourceDefinition.name) ($kvSourceDefinition.root + '/src/threadwrapper/LICENSE') 'licenses/kvazaar-threadwrapper-LICENSE.txt'

# NVIDIA applies the MIT notice per header, rather than in a repository LICENSE.
$nvArchive = [IO.Compression.ZipFile]::OpenRead((Join-Path $taskCacheRoot $nvSourceDefinition.name))
try {
    $nvNotices = @()
    foreach ($entry in ($nvArchive.Entries | Where-Object { $_.FullName -match '/include/ffnvcodec/[^/]+\.h$' } | Sort-Object FullName)) {
        $reader = New-Object IO.StreamReader($entry.Open())
        try { $header = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $notice = [regex]::Match($header, '(?s)^/\*.*?\*/').Value
        if ($notice -notmatch 'Copyright|Permission') { throw 'Original NVIDIA header notice is absent.' }
        $nvNotices += $entry.FullName + "`n" + $notice
    }
    [IO.File]::WriteAllText((Join-Path $taskMediaRoot 'licenses\nv-codec-headers-LICENSE.txt'), (($nvNotices -join "`n`n") + "`n"), $utf8NoBom)
} finally { $nvArchive.Dispose() }

$goLicense = Get-VerifiedArchive 'go-go1.27.2-LICENSE.txt' 'https://raw.githubusercontent.com/golang/go/go1.27.2/LICENSE' '911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad'
$goPatents = Get-VerifiedArchive 'go-go1.27.2-PATENTS.txt' 'https://raw.githubusercontent.com/golang/go/go1.27.2/PATENTS' '96f408bfae65bf137fc2525d3ecb030271c50c1e90799f87abf8846d8dd505cc'
Copy-Item -LiteralPath $goLicense -Destination (Join-Path $taskMediaRoot 'licenses\go-LICENSE.txt') -Force
Copy-Item -LiteralPath $goPatents -Destination (Join-Path $taskMediaRoot 'licenses\go-PATENTS.txt') -Force
$collectorArguments = @('-X', 'utf8', (Join-Path $taskMediaRoot 'sources\collect-mediamtx-licenses.py'), '--media-root', $taskMediaRoot, '--cache', (Join-Path $taskCacheRoot 'go-modules'))
if ($Offline) { $collectorArguments += '--offline' }
& python @collectorArguments
if ($LASTEXITCODE -ne 0) { throw 'MediaMTX original module notice verification failed.' }

$taskToolchainRoot = [IO.Path]::GetFullPath($ToolchainPath)
$taskGcc = Join-Path $taskToolchainRoot 'bin\gcc.exe'
$compilerVersion = (& $taskGcc --version 2>&1 | Select-Object -First 1).ToString()
if ($LASTEXITCODE -ne 0 -or $compilerVersion -notmatch '\b16\.1\.0\b') { throw 'The fixed native build requires MinGW GCC 16.1.0.' }
$taskCompilerArchiveUrl = 'https://github.com/niXman/mingw-builds-binaries/releases/download/16.1.0-rt_v14-rev0/x86_64-16.1.0-release-posix-seh-ucrt-rt_v14-rev0.7z'
$taskCompilerArchiveHash = 'ecaceb42639d21c695f875800a29b2dea76bbb05eb2a1cca3049b65499b8d867'
$null = Get-VerifiedArchive 'x86_64-16.1.0-release-posix-seh-ucrt-rt_v14-rev0.7z' $taskCompilerArchiveUrl $taskCompilerArchiveHash
# These individual hashes were checked against the verified official archive.
if ((Get-Sha256 $taskGcc) -ne 'b679be675c6dcddee63cf973f8bcbde303a421b531d88688ae962715eb01e650' -or
    (Get-Sha256 (Join-Path $taskToolchainRoot 'bin\libwinpthread-1.dll')) -ne '8711dd7e72bbfde9d4c413de971687eafda310331a6def5327ef14e7e2294de8' -or
    (Get-Sha256 (Join-Path $taskToolchainRoot 'build-info.txt')) -ne '6d15780c5c63966b4df9ce9c8a2e49f17d3c373a8c6ad900a7b13b17441edd30') {
    throw 'Installed compiler/runtime differs from the fixed official toolchain.'
}
$taskFs = New-Object -ComObject Scripting.FileSystemObject
$taskShortRoot = $taskFs.GetFolder($taskProjectRoot).ShortPath
if ($taskShortRoot -match ' ') { throw 'The native FFmpeg build requires a Windows short path or project directory without spaces.' }
$taskPrefix = Join-Path $taskShortRoot '.cache\media-dependencies\native-prefix'
$taskKvBuild = Join-Path $taskShortRoot '.cache\media-dependencies\kvazaar-build'
$taskFfBuild = Join-Path $taskShortRoot '.cache\media-dependencies\ffmpeg-build'
New-Item -ItemType Directory -Force -Path (Join-Path $taskPrefix 'include\ffnvcodec') | Out-Null
$taskPreviousPath = $env:PATH
try {
    $env:PATH = (Join-Path $taskToolchainRoot 'bin') + ';' + (Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($BashPath))) 'usr\bin') + ';' + $taskPreviousPath
    if (-not $UseCachedBuild) {
        Get-ChildItem -LiteralPath (Join-Path $taskCacheRoot ($nvSourceDefinition.root + '\include\ffnvcodec')) -Filter '*.h' | Copy-Item -Destination (Join-Path $taskPrefix 'include\ffnvcodec') -Force
        $kvArguments = @('-S', (Join-Path $taskShortRoot ('.cache\media-dependencies\' + $kvSourceDefinition.root)), '-B', $taskKvBuild, '-G', 'MinGW Makefiles', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTS=OFF', '-DBUILD_KVAZAAR_BINARY=OFF', '-DUSE_CRYPTO=OFF', ('-DCMAKE_C_COMPILER=' + $taskGcc.Replace('\','/')), ('-DCMAKE_CXX_COMPILER=' + (Join-Path $taskToolchainRoot 'bin\g++.exe').Replace('\','/')), ('-DCMAKE_INSTALL_PREFIX=' + $taskPrefix))
        & $CmakePath @kvArguments *> (Join-Path $taskCacheRoot 'kvazaar-configure.log')
        if ($LASTEXITCODE -ne 0) { throw 'Kvazaar configure failed; inspect the project cache log.' }
        & $CmakePath --build $taskKvBuild --parallel $Jobs *> (Join-Path $taskCacheRoot 'kvazaar-build.log')
        if ($LASTEXITCODE -ne 0) { throw 'Kvazaar build failed; inspect the project cache log.' }
        & $CmakePath --install $taskKvBuild *> (Join-Path $taskCacheRoot 'kvazaar-install.log')
        if ($LASTEXITCODE -ne 0) { throw 'Kvazaar install failed; inspect the project cache log.' }
        $env:LAN_MEDIA_JOBS = [string]$Jobs
        Remove-Item -LiteralPath 'Env:\LAN_MEDIA_SKIP_CONFIG' -ErrorAction SilentlyContinue
        & $BashPath --noprofile --norc (Join-Path $taskShortRoot 'vendor\media\sources\rebuild-ffmpeg.sh') (Join-Path $taskShortRoot ('.cache\media-dependencies\' + $ffmpegSourceDefinition.root)) $taskPrefix $taskFfBuild *> (Join-Path $taskCacheRoot 'minimal-ffmpeg-build.log')
        if ($LASTEXITCODE -ne 0) { throw 'Minimal FFmpeg build failed; inspect the project cache log.' }
    }
    $nativeBinaries = @('ffmpeg.exe','ffprobe.exe','avcodec-62.dll','avdevice-62.dll','avfilter-11.dll','avformat-62.dll','avutil-60.dll','swresample-6.dll','swscale-9.dll')
    foreach ($name in $nativeBinaries) {
        Copy-Item -LiteralPath (Join-Path $taskPrefix ('bin\' + $name)) -Destination (Join-Path $taskMediaRoot ('bin\' + $name)) -Force
    }
    # GCC's static runtime contains emulated thread-local storage which uses
    # the toolchain's winpthreads DLL even when FFmpeg uses Windows threads.
    Copy-Item -LiteralPath (Join-Path $taskToolchainRoot 'bin\libwinpthread-1.dll') -Destination (Join-Path $taskMediaRoot 'bin\libwinpthread-1.dll') -Force
    $ffmpegVersionLines = & (Join-Path $taskMediaRoot 'bin\ffmpeg.exe') -version 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Built FFmpeg cannot load its shared libraries.' }
    $ffmpegVersionText = ($ffmpegVersionLines | ForEach-Object { $_.ToString() }) -join "`n"
    if ($ffmpegVersionText -notmatch 'lan-cast-1' -or $ffmpegVersionText -match '--enable-gpl|--enable-nonfree|--enable-chromaprint|--enable-libx264|--enable-libx265') { throw 'Unexpected or unsafe FFmpeg build configuration.' }
    if ($ffmpegVersionText -notmatch '--enable-muxer=[^\r\n]*pcm_f32le' -or $ffmpegVersionText -notmatch '--enable-filter=[^\r\n]*showinfo') { throw 'The cached native build is missing required media verification support.' }
    if ($ffmpegVersionText -notmatch '--enable-decoder=[^\r\n]*wrapped_avframe' -or $ffmpegVersionText -notmatch '--enable-encoder=[^\r\n]*wrapped_avframe') { throw 'The cached native build is missing required lavfi/null frame codecs.' }
    $ffmpegBuildconfLines = & (Join-Path $taskMediaRoot 'bin\ffmpeg.exe') -hide_banner -buildconf 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg build configuration inspection failed.' }
} finally { $env:PATH = $taskPreviousPath }
[IO.File]::WriteAllText((Join-Path $taskMediaRoot 'licenses\ffmpeg-version.txt'), ($ffmpegVersionText + "`n"), $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $taskMediaRoot 'licenses\ffmpeg-buildconf.txt'), ((($ffmpegBuildconfLines | ForEach-Object { $_.ToString() }) -join "`n") + "`n"), $utf8NoBom)

$runtimeLicenses = @('winpthreads\COPYING','mingw-w64\COPYING.MinGW-w64-runtime.txt','mingw-w64\COPYING.MinGW-w64.txt','mingw-w64\DISCLAIMER','mingw-w64\DISCLAIMER.PD','mingw-w64\direct-x-COPYING.lib','gcc\COPYING.RUNTIME','gcc\COPYING3','gcc\COPYING3.LIB')
$runtimeLicenseHashes = @{
    'winpthreads\COPYING' = '1c8d23063c3772b9435831410b31b51fef3d9cf2138a442dc367ef5d72239f67'
    'mingw-w64\COPYING.MinGW-w64-runtime.txt' = 'e7a33fd8d164abd188ee629bbe3b07912419b29192a6bbfdce29de0ad4f0e7fb'
    'mingw-w64\COPYING.MinGW-w64.txt' = '8b5b2c7c74842122f7a2479653dc612aa8e1c313bfec63808f90517ae13af40a'
    'mingw-w64\DISCLAIMER' = '84db291f8e4654556fd6de6ca888d9891c414154ddc20deda82265dacf10d236'
    'mingw-w64\DISCLAIMER.PD' = '716fee4352b35ba28ea2cec0c0d7654ca3a93966226f4eb9555e4f9b900866e3'
    'mingw-w64\direct-x-COPYING.lib' = '1e7e6bae5a5bde32f1ae5a7c37a082d1ab03cf89354f7f936ac40be9e39a6531'
    'gcc\COPYING.RUNTIME' = '90077ba306ee9d8ed966cab1b4abd69b6e728acf08777283cc50283cd9503fa6'
    'gcc\COPYING3' = '0b383d5a63da644f628d99c33976ea6487ed89aaa59f0b3257992deac1171e6b'
    'gcc\COPYING3.LIB' = '319917f5ccd09878db6f67c9a77dee846055644ca49eb535628b9e020a87261e'
}
foreach ($license in $runtimeLicenses) {
    $originalLicense = Join-Path $taskToolchainRoot ('licenses\' + $license)
    if ((Get-Sha256 $originalLicense) -ne $runtimeLicenseHashes[$license]) { throw "Fixed original runtime notice differs: $license" }
    $destination = Join-Path $taskMediaRoot ('licenses\toolchain\' + $license)
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
    Copy-Item -LiteralPath $originalLicense -Destination $destination -Force
}
Copy-Item -LiteralPath (Join-Path $taskToolchainRoot 'build-info.txt') -Destination (Join-Path $taskMediaRoot 'licenses\toolchain-build-info.txt') -Force

$dependencies = @(
    [ordered]@{ name='MediaMTX'; version='1.21.2'; licenseExpression='MIT'; archiveSha256=$mediaMtxArchiveHash; sources=@('https://github.com/bluenviron/mediamtx/releases/tag/v1.21.2', $sourceDefinitions[3].url); sourceCommit='914e39535ece709919ac325aaeed98d394ed9093'; moduleNotices='licenses/mediamtx-dependencies.json'; buildConfiguration='Official windows_amd64 release; Go 1.27.2; CGO_ENABLED=0; GOAMD64=v1; vcs.modified=false' },
    [ordered]@{ name='FFmpeg'; version=($ffmpegVersionLines[0].ToString()); licenseExpression='LGPL-2.1-or-later'; archiveSha256=$ffmpegSourceDefinition.sha; sources=@($ffmpegSourceDefinition.url, 'sources/rebuild-ffmpeg.sh', 'sources/minimal-pkg-config.sh'); sourceCommit='46d899d7a02bc63237472cc4897258d5ddf274ac'; buildConfiguration=($ffmpegVersionLines | Where-Object { $_.ToString().StartsWith('configuration:') } | ForEach-Object { $_.ToString().Substring(15).Trim() }) },
    [ordered]@{ name='Kvazaar'; version='2.3.2'; licenseExpression='BSD-3-Clause AND ISC'; archiveSha256=$kvSourceDefinition.sha; sources=@($kvSourceDefinition.url); sourceCommit='2b06691bb5844404c0e703f12a5d7b0fee914ec7'; buildConfiguration='CMake Release; BUILD_SHARED_LIBS=OFF; BUILD_TESTS=OFF; BUILD_KVAZAAR_BINARY=OFF; USE_CRYPTO=OFF; linked statically into avcodec' },
    [ordered]@{ name='nv-codec-headers'; version='13.0.19.2.0'; licenseExpression='MIT'; archiveSha256=$nvSourceDefinition.sha; sources=@($nvSourceDefinition.url); sourceCommit='ced4f8eba3ba5dd431932cba17928f0dffdaeb2b'; buildConfiguration='Headers only; SDK 13.0.19; Windows NVIDIA driver 570 or later; no NVIDIA driver DLL distributed' },
    [ordered]@{ name='MinGW runtime'; version='GCC 16.1.0; MinGW-w64 14; UCRT; posix-seh-rev0'; licenseExpression='GPL-3.0-or-later WITH GCC-exception-3.1; MIT; BSD-3-Clause; public domain'; archiveSha256=$taskCompilerArchiveHash; sources=@($taskCompilerArchiveUrl, 'https://github.com/niXman/mingw-builds', 'licenses/toolchain-build-info.txt'); buildConfiguration='-static-libgcc; static winpthreads for Kvazaar; libwinpthread-1.dll required by libgcc emulated TLS; original compiler runtime notices included'; compilerVersion=$compilerVersion; compilerSha256=(Get-Sha256 $taskGcc); winpthreadsSha256=(Get-Sha256 (Join-Path $taskToolchainRoot 'bin\libwinpthread-1.dll')) }
)

$relativePaths = [string[]]@(Get-ChildItem -LiteralPath $taskMediaRoot -Recurse -File | Where-Object { $_.FullName -ne $taskManifestPath } | ForEach-Object { $_.FullName.Substring($taskMediaRoot.Length + 1).Replace('\','/') })
[Array]::Sort($relativePaths, [StringComparer]::Ordinal)
$manifestFiles = foreach ($relative in $relativePaths) {
    $absolute = Join-Path $taskMediaRoot $relative
    [ordered]@{ path=$relative; sha256=(Get-Sha256 $absolute); size=(Get-Item -LiteralPath $absolute).Length }
}
$manifest = [ordered]@{ schemaVersion=1; dependencies=$dependencies; files=@($manifestFiles) }
[IO.File]::WriteAllText($taskManifestPath, (($manifest | ConvertTo-Json -Depth 12) + "`n"), $utf8NoBom)
Test-MediaManifest
