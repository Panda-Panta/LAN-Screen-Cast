#!/usr/bin/env bash
set -euo pipefail

# The native build has exactly two external packages. This small pkg-config
# implementation avoids discovering libraries from the developer's computer.
# FFmpeg still compiles and links its own feature probes against these headers.
: "${LAN_MEDIA_PREFIX:?Set LAN_MEDIA_PREFIX to the native dependency prefix}"
request="$*"
case "$request" in
  *ffnvcodec*)
    package=ffnvcodec
    package_version=13.0.19.2.0
    package_cflags="-I${LAN_MEDIA_PREFIX}/include"
    package_libs=''
    ;;
  *kvazaar*)
    package=kvazaar
    package_version=2.3.2
    package_cflags="-I${LAN_MEDIA_PREFIX}/include -DKVZ_STATIC_LIB"
    package_libs="-L${LAN_MEDIA_PREFIX}/lib -lkvazaar -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic"
    ;;
  *--version*) printf '%s\n' '0.29.2'; exit 0 ;;
  *) exit 1 ;;
esac

version_cmp() {
  local lhs="$1" rhs="$2" op="$3" first
  first=$(printf '%s\n%s\n' "$lhs" "$rhs" | sort -V | head -n 1)
  case "$op" in
    '>=' ) [[ "$first" == "$rhs" ]] ;;
    '>'  ) [[ "$first" == "$rhs" && "$lhs" != "$rhs" ]] ;;
    '<=' ) [[ "$first" == "$lhs" ]] ;;
    '<'  ) [[ "$first" == "$lhs" && "$lhs" != "$rhs" ]] ;;
    '='  ) [[ "$lhs" == "$rhs" ]] ;;
    *) return 1 ;;
  esac
}

for argument in "$@"; do
  if [[ "$argument" =~ ^$package[[:space:]]*(\>=|\>|\<=|\<|=)[[:space:]]*([0-9.]+)$ ]]; then
    version_cmp "$package_version" "${BASH_REMATCH[2]}" "${BASH_REMATCH[1]}" || exit 1
  fi
done
case "$request" in
  *--modversion*) printf '%s\n' "$package_version" ;;
  *--cflags*) printf '%s\n' "$package_cflags" ;;
  *--libs*) printf '%s\n' "$package_libs" ;;
  *--exists*) exit 0 ;;
  *) exit 1 ;;
esac
