"""Create a complete Windows portable ZIP and verify its CRC and hashes."""
from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "release"
RUNTIME = RELEASE / "win-unpacked"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
PREFIX = "LAN Screen Cast"


def sha256(file: Path) -> str:
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def public_evidence(value):
    if isinstance(value, dict):
        private = {"candidatetypes", "bindaddress", "label", "address", "host", "ip", "ipv4", "ipv6",
                   "gateway", "wanaddress", "externaladdress", "commandline", "password", "token", "pin",
                   "generation", "roomid", "viewerid", "localurl", "forwardedurl", "inviteurl", "rtmpurl",
                   "firsturl", "secondurl", "url", "urls", "guiurl", "executablepath", "temproot", "userdata"}
        return {key: public_evidence(item) for key, item in value.items()
                if re.sub(r"[-_]", "", key).lower() not in private
                and not re.search(r"(?:invite|rtmp|web).*url$", key, re.IGNORECASE)}
    if isinstance(value, list):
        return [public_evidence(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r'\b(?:rtmps?|https?|wss?)://[^\s"\'<>]+', "[session address redacted]", value, flags=re.IGNORECASE)
        value = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[IP redacted]", value)
        value = re.sub(r"(?<![\w:])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]+(?:%[\w.-]+)?", "[IP redacted]", value, flags=re.IGNORECASE)
        value = re.sub(r"\b(token|password|pin|generation)=[^\s&]+", r"\1=[redacted]", value, flags=re.IGNORECASE)
        return value
    return value


def native_media(directory: Path, expected: Path | None = None) -> dict:
    command = ["node", str(ROOT / "scripts" / "media-evidence.js"), str(directory)]
    if expected is not None:
        command.append(str(expected))
    return json.loads(subprocess.run(command, cwd=ROOT, check=True, capture_output=True, encoding="utf-8").stdout)


def number_at_least(value, minimum: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= minimum


def verify_rtmp_report(name: str, data: dict) -> None:
    # A ready-state claim must be backed by actual bundled producer arguments,
    # decoded video frames, AAC and final mixed PCM for both hardware codecs.
    for codec_key, encoder_key, requested_codec, decoded_codec, hardware in [
            ("codecs", "h264HardwareEncoder", "H264", "h264", True),
            ("softwareCodecs", "h264SoftwareEncoder", "H264", "h264", False),
            ("hevcCodecs", "hevcHardwareEncoder", "HEVC", "hevc", True),
            ("hevcSoftwareCodecs", "hevcSoftwareEncoder", "HEVC", "hevc", False)]:
        codec = data.get(codec_key, {})
        encoder = data.get(encoder_key, {})
        if (encoder.get("codec") != requested_codec or encoder.get("hardware") is not hardware
                or not isinstance(encoder.get("encoder"), str) or not encoder["encoder"] or encoder["encoder"] == "copy"
                or encoder.get("confirmedByOwnedPublisherArguments") is not True
                or encoder.get("statusStatesActualAcceleration") is not True
                or not number_at_least(encoder.get("actualDecodedVideoFrames"), 3)
                or not number_at_least(codec.get("liveDecodedVideoFrames"), 3)
                or not number_at_least(codec.get("liveDecodedAudioSamples"), 48001)
                or codec.get("finalizedCapture") is not True or codec.get("receiverSpeakerOutput") is not False):
            raise RuntimeError(f"Required actual RTMP codec/encoder proof is incomplete: {name}/{codec_key}")
        streams = codec.get("streams", [])
        video = next((item for item in streams if item.get("codec_type") == "video"), {})
        audio = next((item for item in streams if item.get("codec_type") == "audio"), {})
        try:
            frames = int(video.get("nb_read_frames", 0))
        except (ValueError, TypeError):
            frames = 0
        if video.get("codec_name") != decoded_codec or frames < 3 or audio.get("codec_name") != "aac":
            raise RuntimeError(f"RTMP finalized native decoder proof is incomplete: {name}/{codec_key}")
    for measurement in ["bothInputs", "software", "hevc", "hevcSoftware"]:
        pcm = data.get("measurements", {}).get(measurement, {})
        if (not number_at_least(pcm.get("samples"), 48000)
                or not number_at_least(pcm.get("decodedFrames"), 3)
                or not number_at_least(pcm.get("system", {}).get("amplitude"), 0.0001)
                or not number_at_least(pcm.get("microphone", {}).get("amplitude"), 0.0001)):
            raise RuntimeError(f"RTMP mixed output PCM proof is incomplete: {name}/{measurement}")


def verify_portable_rtmp(data: dict) -> None:
    defaults = data.get("defaults", {})
    if (defaults.get("codec") != "HEVC" or defaults.get("rtmpEnabled") is not True
            or defaults.get("rtmpCodec") != "HEVC" or defaults.get("rtmpAcceleration") != "auto"):
        raise RuntimeError("Portable fresh defaults do not prove web HEVC and RTMP HEVC/auto")
    rtmp = data.get("rtmp", {})
    encoder = rtmp.get("encoder")
    hardware = rtmp.get("hardware")
    # NVIDIA remains the first candidate, but a different host may legitimately
    # prove another hardware encoder or same-codec software fallback under auto.
    allowed_encoders = {"hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_mf"} if hardware is True else {"hevc_mf", "libkvazaar"}
    if (rtmp.get("ready") is not True or rtmp.get("codec") != "HEVC"
            or rtmp.get("accelerationRequested") != "auto"
            or not isinstance(rtmp.get("runtimeCodec"), str)
            or not re.search(r"HEVC|H\.?265", rtmp["runtimeCodec"], re.IGNORECASE)
            or not isinstance(hardware, bool) or not isinstance(encoder, str) or encoder not in allowed_encoders
            or rtmp.get("confirmedByOwnedPublisherArguments") is not True
            or rtmp.get("statusStatesActualAcceleration") is not True
            or not number_at_least(rtmp.get("decodedVideoFrames"), 3)
            or rtmp.get("enhancedRtmpRead") is not True
            or rtmp.get("receiverSpeakerOutput") is not False
            or rtmp.get("copyMatchesAddress") is not True
            or rtmp.get("ownedListenersReleased") is not True):
        raise RuntimeError("Portable HEVC/auto result lacks actual publisher, acceleration, decode, copy or stop proof")


def main() -> None:
    exe = RUNTIME / "LAN Screen Cast.exe"
    asar = RUNTIME / "resources" / "app.asar"
    if not exe.is_file() or not asar.is_file():
        raise RuntimeError("Build the Windows portable directory first")
    current = json.loads(subprocess.run(["node", str(ROOT / "scripts" / "source-fingerprint.js")],
                                      cwd=ROOT, check=True, capture_output=True, encoding="utf-8").stdout)
    media_root = RUNTIME / "resources" / "media"
    media = native_media(media_root, ROOT / "vendor" / "media")
    if media != current.get("nativeMedia"):
        raise RuntimeError("Native dependency inputs changed while obtaining source evidence")
    bundle = json.loads((ROOT / "test-results" / "bundle-verification.json").read_text(encoding="utf-8"))
    if (bundle.get("productionFilesMatchSource") is not True
            or bundle.get("version") != VERSION or bundle.get("asarSha256") != sha256(asar)
            or bundle.get("sourceFingerprint") != current["sourceFingerprint"]
            or bundle.get("nativeMediaFilesMatchSource") is not True or bundle.get("nativeMedia") != media
            or bundle.get("nativeMediaVerifiedFiles") != len(media["files"]) + 1):
        raise RuntimeError("Packaged ASAR does not match the verified production source")
    results = {}
    for name in ["smoke", "gui-regressions", "features-smoke", "system-audio-smoke", "rtmp-smoke",
                 "packaged-smoke", "packaged-gui-regressions", "packaged-features-smoke", "packaged-system-audio-smoke", "packaged-rtmp-smoke"]:
        data = json.loads((ROOT / "test-results" / f"{name}.json").read_text(encoding="utf-8"))
        if data.get("passed") is not True:
            raise RuntimeError(f"Required runtime verification did not pass: {name}")
        if data.get("version") != VERSION:
            raise RuntimeError(f"Runtime result has no matching actual application version: {name}")
        if (data.get("sourceFingerprint") != current["sourceFingerprint"]
                or data.get("validationFingerprint") != current["validationFingerprint"]
                or data.get("nativeMedia") != media):
            raise RuntimeError(f"Runtime result does not match current source, verification tools and native bytes: {name}")
        if name.startswith("packaged-"):
            evidence = data.get("packagedRuntime", {})
            if (evidence.get("version") != VERSION or evidence.get("asarSha256") != sha256(asar)
                    or evidence.get("executableSha256") != sha256(exe) or evidence.get("nativeMedia") != media):
                raise RuntimeError(f"Runtime result is not from this exact candidate: {name}")
        if name.endswith("rtmp-smoke"):
            verify_rtmp_report(name, data)
            results[name] = public_evidence(data)
            continue
        results[name] = {key: data[key] for key in ["startedAt", "scope", "checks", "passed"]}
        if "packagedRuntime" in data:
            results[name]["packagedRuntime"] = data["packagedRuntime"]
        for key in ["windowCapture", "screenCapture", "audio", "microphoneCapture", "microphone", "hevc", "senderHevc", "fallback", "wanRefresh",
                    "screenMixedCapture", "measurements", "windowCleanup", "mixedCleanup", "settingsRestore", "fixtures", "outputFixtureClosed"]:
            if key in data:
                results[name][key] = public_evidence(data[key])
    tests_text = (ROOT / "test-results" / "node-tests.txt").read_text(encoding="utf-8-sig")
    syntax_text = (ROOT / "test-results" / "syntax-check.txt").read_text(encoding="utf-8-sig")
    validation = json.loads((ROOT / "test-results" / "validation-evidence.json").read_text(encoding="utf-8"))
    if (validation.get("passed") is not True or validation.get("version") != VERSION
            or validation.get("sourceFingerprint") != current["sourceFingerprint"]
            or validation.get("validationFingerprint") != current["validationFingerprint"]
            or validation.get("nativeMedia") != media
            or validation.get("nodeLogSha256") != sha256(ROOT / "test-results" / "node-tests.txt")
            or validation.get("syntaxLogSha256") != sha256(ROOT / "test-results" / "syntax-check.txt")):
        raise RuntimeError("Node/syntax evidence is not from the current validation inputs")
    tests = re.search(r"(?m)^ℹ tests (\d+)\s*$", tests_text)
    passed = re.search(r"(?m)^ℹ pass (\d+)\s*$", tests_text)
    failed = re.search(r"(?m)^ℹ fail (\d+)\s*$", tests_text)
    syntax = re.search(r"Syntax checked (\d+) JavaScript files", syntax_text)
    if not all([tests, passed, failed, syntax]) or int(failed[1]) != 0 or tests[1] != passed[1]:
        raise RuntimeError("Required Node/syntax logs do not prove a complete passing run")
    summary = {"version": VERSION, "runtime": "Electron 44.7.0 / Windows x64", "nativeMedia": media,
               "nodeTests": int(tests[1]), "nodeTestsPassed": int(passed[1]), "syntaxFiles": int(syntax[1]), "results": results,
               "bundle": bundle, "validation": validation,
               "boundaries": ["Same-PC sessions, no physical five-device test", "No real campus router traversal test",
                              "No 100 Mbps traffic shaping or end-to-end latency measurement"]}
    launcher_report_path = ROOT / "test-results" / "portable-launch.json"
    launcher = json.loads(launcher_report_path.read_text(encoding="utf-8")) if launcher_report_path.is_file() else {}
    portable = RELEASE / f"LAN-Screen-Cast-{VERSION}-win-x64.exe"
    if launcher.get("passed") is not True:
        raise RuntimeError("Required single-file portable launch verification did not pass")
    if (launcher.get("version") != VERSION or not portable.is_file()
            or launcher.get("executableSha256") != sha256(portable) or launcher.get("embeddedAsarSha256") != sha256(asar)
            or launcher.get("embeddedExecutableSha256") != sha256(exe)
            or launcher.get("sourceFingerprint") != current["sourceFingerprint"]
            or launcher.get("validationFingerprint") != current["validationFingerprint"]
            or launcher.get("nativeMedia") != media or launcher.get("nativeMediaFilesMatchSource") is not True):
        raise RuntimeError("Portable launch result is not from this exact candidate")
    verify_portable_rtmp(launcher)
    if launcher.get("passed") is True:
        summary["singleFileLauncher"] = public_evidence({key: launcher[key] for key in ["startedAt", "scope", "checks", "passed", "version", "executableSha256", "embeddedAsarSha256", "embeddedExecutableSha256", "nativeMedia", "nativeMediaFilesMatchSource", "defaults", "rtmp"]})
    archive = RELEASE / f"LAN-Screen-Cast-{VERSION}-win-x64.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for file in sorted(RUNTIME.rglob("*")):
            if file.is_symlink():
                raise RuntimeError(f"Refusing a runtime symbolic link: {file.relative_to(RUNTIME)}")
            if file.is_file():
                package.write(file, f"{PREFIX}/{file.relative_to(RUNTIME).as_posix()}")
        package.write(ROOT / "README.md", f"{PREFIX}/README.md")
        for name in ["DEVELOPMENT_PLAN.md", "PROJECT_STRUCTURE.md"]:
            package.write(ROOT / name, f"{PREFIX}/{name}")
        package.write(ROOT / "LICENSE", f"{PREFIX}/LICENSE.project.txt")
        for file in sorted((ROOT / "docs").rglob("*.md")):
            package.write(file, f"{PREFIX}/docs/{file.relative_to(ROOT / 'docs').as_posix()}")
        for name in ["node-tests.txt", "syntax-check.txt"]:
            package.write(ROOT / "test-results" / name, f"{PREFIX}/verification/{name}")
        package.writestr(f"{PREFIX}/verification/runtime-summary.json", json.dumps(summary, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(archive) as package:
        bad = package.testzip()
        if bad is not None:
            raise RuntimeError(f"ZIP CRC failure: {bad}")
        entries = package.infolist()
        if not any(entry.filename == f"{PREFIX}/LAN Screen Cast.exe" for entry in entries):
            raise RuntimeError("Missing portable executable")
        if any("/.cache/" in entry.filename or "/test-results/" in entry.filename for entry in entries):
            raise RuntimeError("Unexpected private test/cache content")
        for file in [exe, asar]:
            entry_name = f"{PREFIX}/{file.relative_to(RUNTIME).as_posix()}"
            with package.open(entry_name) as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != sha256(file):
                    raise RuntimeError(f"Archived file differs from tested runtime: {entry_name}")
        native_prefix = f"{PREFIX}/resources/media/"
        expected_media = {file["path"]: file for file in media["files"]}
        expected_media["manifest.json"] = {"sha256": media["manifestSha256"], "size": (media_root / "manifest.json").stat().st_size}
        actual_media = {entry.filename[len(native_prefix):] for entry in entries if entry.filename.startswith(native_prefix)}
        if actual_media != set(expected_media):
            raise RuntimeError("Archived native dependency inventory differs from tested runtime")
        for relative, evidence in expected_media.items():
            entry_name = native_prefix + relative
            if package.getinfo(entry_name).file_size != evidence["size"]:
                raise RuntimeError(f"Archived native dependency size differs: {relative}")
            with package.open(entry_name) as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != evidence["sha256"]:
                    raise RuntimeError(f"Archived native dependency hash differs: {relative}")
    artifacts = [archive, exe, asar]
    if portable.is_file() and launcher.get("passed") is True:
        artifacts.append(portable)
    hashes = [{"file": file.relative_to(RELEASE).as_posix(), "bytes": file.stat().st_size, "sha256": sha256(file)} for file in artifacts]
    report = {"version": VERSION, "zipCrcPassed": True, "zipEntries": len(entries),
              "uncompressedBytes": sum(entry.file_size for entry in entries), "artifacts": hashes,
              "archivedRuntimeHashesMatch": True,
              "archivedNativeMediaHashesMatch": True, "nativeMediaFilesMatchSource": True,
              "nativeMediaVerifiedFiles": len(media["files"]) + 1, "nativeMedia": media,
              "productionFilesMatchSource": True, "sourceFilesVerified": bundle["verifiedFiles"],
              "runtimeValidationPassed": True, "singleFileLauncherPassed": launcher.get("passed") is True,
              "scope": summary["boundaries"]}
    (RELEASE / "release-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (RELEASE / "SHA256SUMS.txt").write_text("\n".join(f"{entry['sha256']}  {entry['file']}" for entry in hashes) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
