#!/usr/bin/env bash
set -euo pipefail

# Source and prefix directories must have no spaces. Windows callers can use
# verified 8.3 paths. This script changes only the supplied build directory.
if [[ $# -ne 3 ]]; then
  printf '%s\n' 'Usage: rebuild-ffmpeg.sh FFmpeg-source native-prefix build-directory' >&2
  exit 2
fi
source_dir=$(cygpath -m "$1")
export LAN_MEDIA_PREFIX=$(cygpath -m "$2")
build_dir=$(cygpath -m "$3")
script_dir=$(cygpath -m "$(dirname "$0")")
case "$source_dir $LAN_MEDIA_PREFIX $build_dir $script_dir" in
  *' '* )
    # The separator spaces are intentional; check each individual path below.
    for build_path in "$source_dir" "$LAN_MEDIA_PREFIX" "$build_dir" "$script_dir"; do
      [[ "$build_path" != *' '* ]] || { printf '%s\n' 'Use a build path without spaces or a Windows short path.' >&2; exit 2; }
    done
    ;;
esac
mkdir -p "$build_dir"
cd "$build_dir"

if [[ "${LAN_MEDIA_SKIP_CONFIG:-0}" != 1 ]]; then
bash "$source_dir/configure" \
  --prefix="$LAN_MEDIA_PREFIX" \
  --arch=x86_64 --target-os=mingw32 \
  --cc=gcc --cxx=g++ --ar=ar --nm=nm --ranlib=ranlib \
  --disable-autodetect --disable-gpl --disable-nonfree --disable-version3 \
  --disable-debug --disable-doc --disable-x86asm --disable-everything \
  --enable-shared --disable-static --disable-ffplay \
  --enable-ffmpeg --enable-ffprobe --enable-network \
  --disable-pthreads --enable-w32threads \
  --enable-mediafoundation --enable-d3d11va --enable-ffnvcodec --enable-nvenc --enable-libkvazaar \
  --pkg-config="bash $script_dir/minimal-pkg-config.sh" \
  --extra-ldflags=-static-libgcc --extra-version=lan-cast-1 \
  --enable-protocol=file,pipe,tcp,rtmp \
  --enable-demuxer=matroska,flv,mov,wav,rawvideo,pcm_s16le \
  --enable-muxer=flv,matroska,wav,rawvideo,pcm_s16le,pcm_f32le,null,mpegts \
  --enable-parser=aac,aac_latm,h264,hevc,opus,vp8 \
  --enable-decoder=aac,aac_fixed,h264,hevc,opus,vp8,pcm_s16le,pcm_f32le,rawvideo,wrapped_avframe \
  --enable-encoder=aac,h264_mf,hevc_mf,h264_nvenc,hevc_nvenc,libkvazaar,pcm_s16le,pcm_f32le,rawvideo,wrapped_avframe \
  --enable-bsf=extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,null \
  --enable-indev=lavfi \
  --enable-filter=aresample,aformat,anull,anullsink,null,nullsink,scale,format,fps,setsar,setpts,asetpts,testsrc,testsrc2,sine,anullsrc,color,drawbox,pad,crop,amix,volume,showinfo
fi

# configure runs in MSYS Bash, while mingw32-make is a native Windows tool.
# Normalize generated include paths; no upstream source file is modified.
[[ "$source_dir" != *'#'* && "$source_dir" != *'&'* ]] || exit 2
printf 'include %s/Makefile\n' "$source_dir" > Makefile
sed -i "s#^SRC_PATH=.*#SRC_PATH=$source_dir#;s#^SRC_LINK=.*#SRC_LINK=$source_dir#" ffbuild/config.mak

mingw32-make -j "${LAN_MEDIA_JOBS:-8}" SHELL=bash
mingw32-make SHELL=bash install
