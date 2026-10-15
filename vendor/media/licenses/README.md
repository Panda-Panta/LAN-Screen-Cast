# Bundled native media components

`bin/` contains MediaMTX, FFmpeg, FFprobe, seven replaceable FFmpeg DLLs, and
the required MinGW winpthreads DLL. `manifest.json` records every distributed
binary, original notice, source archive and build script with its byte length
and SHA256. The manifest itself is fingerprinted by the release evidence.

## FFmpeg and codec libraries

FFmpeg is built from upstream commit
`46d899d7a02bc63237472cc4897258d5ddf274ac` on the 8.1 branch. The complete,
unmodified source ZIP is provided in `sources/`. Its applicable license is
LGPL 2.1 or later; see `ffmpeg-LICENSE.txt` and upstream `ffmpeg-LICENSE.md`.
`ffmpeg-version.txt` and `ffmpeg-buildconf.txt` are captured from the shipped
executable. The build disables GPL, nonfree, version3 and library autodetection.
It does not include x264, x265, FFTW or chromaprint.

The enabled output encoders include H.264/HEVC Media Foundation, H.264/HEVC
NVIDIA NVENC, BSD Kvazaar software HEVC, and FFmpeg's native AAC. Availability
in the encoder list is separate from successful frame encoding; hardware,
driver and OS support are checked at runtime by the application.
The built-in `wrapped_avframe` decoder and encoder are enabled for lavfi
generated frame inputs and decoded-video null outputs used by those checks.

Kvazaar 2.3.2, commit `2b06691bb5844404c0e703f12a5d7b0fee914ec7`, is linked
statically into avcodec. Its source ZIP and original BSD 3-clause license are
included, together with its internal thread wrapper's original ISC notice.
The CMake build disables crypto, tests and its standalone CLI.
NVIDIA SDK headers, commit `ced4f8eba3ba5dd431932cba17928f0dffdaeb2b`, are
MIT licensed. Their unmodified source ZIP and original per-header notices are
included. NVENC requires an NVIDIA Windows driver supporting SDK 13.0.19
(570 or newer according to the header repository); no NVIDIA driver DLL is
distributed. QSV and AMF encoders are absent from this minimal build.

FFmpeg links Windows Media Foundation and D3D11 APIs supplied by Windows.
The GCC runtime is linked statically under the GCC Runtime Library Exception
3.1. The required `libwinpthread-1.dll` is from the fixed MinGW toolchain and
has the original MIT and Lockless BSD notices in `toolchain/winpthreads/`.
Original GCC exception, GPL license text and MinGW runtime notices are kept
in `toolchain/`. Including those texts does not enable GPL FFmpeg features.

The shared FFmpeg libraries may be replaced with compatible modified builds.
The supplied sources and build scripts permit rebuilding those libraries;
modification and reverse engineering for debugging such modifications are
permitted as provided by LGPL 2.1. This notice does not limit the applicable
upstream licenses.

## MediaMTX and Go modules

MediaMTX is the official Windows amd64 release v1.21.2, built from commit
`914e39535ece709919ac325aaeed98d394ed9093`, with Go 1.27.2, CGO disabled,
and GOAMD64 v1. Its release archive is checked against the official release
digest and `mediamtx-checksums.sha256`. The MIT license and exact application
source ZIP are included.

`mediamtx-dependencies.json` lists the 85 Go modules actually embedded in the
verified executable. Each official Go module ZIP is verified against both its
embedded Go h1 digest and pinned ZIP SHA256 before notices are copied. Original
root and nested notices are in `mediamtx-modules/`; Go's original license and
patent grant are also included. A historical OpenPGP fork with source-header
notices and no standalone license file is supplied as its complete original
module ZIP in `sources/go-header-notices/`.

## Rebuild and verify

From the project root on Windows:

```powershell
powershell -NoProfile -File scripts/fetch-media-dependencies.ps1
powershell -NoProfile -File scripts/fetch-media-dependencies.ps1 -VerifyOnly
```

The script downloads only fixed official release/source URLs, verifies pinned
SHA256 values, and builds in `.cache/media-dependencies/`. No installed media
tools or user settings are changed. It requires a supplied GCC 16.1.0 MinGW
toolchain (x86_64, posix, SEH, UCRT, rt_v14, rev0), Git Bash, CMake and Python.
Paths can be overridden by its parameters. Native GNU Make requires paths
without spaces; the script resolves the project's existing Windows short path.
Original compiler build metadata is retained in `toolchain-build-info.txt`.
The compiler publisher's fixed release is:

<https://github.com/niXman/mingw-builds-binaries/releases/tag/16.1.0-rt_v14-rev0>

The complete publisher archive is downloaded to the project cache and checked
against its official release SHA256. The used compiler, required DLL and
original runtime notices are pinned to the file hashes verified in that archive.

`sources/rebuild-ffmpeg.sh` contains every configure argument and the two
generated Makefile path adjustments needed when MSYS Bash invokes native
MinGW Make. Upstream source files are not patched. The tiny documented
`sources/minimal-pkg-config.sh` exposes only the two fixed optional codec
dependencies, rather than discovering arbitrary installed libraries.

`-Offline` requires the verified source and Go module archives in the project
cache. `-UseCachedBuild` copies a completed native build from that cache;
omit this switch to reconfigure and rebuild. An unverified cache mismatch is
a failure. `-VerifyOnly` reads the shipped files and rejects missing files,
changed hashes/lengths, extra files and symlinks. Integrity verification does
not by itself prove actual hardware encoding, receiver compatibility, or LAN
reachability; those are separate runtime checks.
