#!/usr/bin/env bash
# CI 里的临时钥匙串:放 Developer ID 证书给 codesign 用,用完删掉。打包和发布两个工作流共用。
#   tools/ci-keychain.sh import   要 APPLE_CERTIFICATE_P12_BASE64、APPLE_CERTIFICATE_PASSWORD、RUNNER_TEMP
#   tools/ci-keychain.sh delete
set -euo pipefail
KEYCHAIN="$RUNNER_TEMP/signing.keychain-db"
case "${1:-}" in
  import)
    umask 077
    PASSWORD="$(openssl rand -hex 32)"
    echo "::add-mask::$PASSWORD"
    security create-keychain -p "$PASSWORD" "$KEYCHAIN"
    security set-keychain-settings -lut 21600 "$KEYCHAIN"
    security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
    security list-keychains -d user -s "$KEYCHAIN"
    echo "$APPLE_CERTIFICATE_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/certificate.p12"
    security import "$RUNNER_TEMP/certificate.p12" -k "$KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" \
      -T /usr/bin/codesign -T /usr/bin/security >/dev/null
    security set-key-partition-list -S apple-tool:,apple: -s -k "$PASSWORD" "$KEYCHAIN" >/dev/null
    rm -f "$RUNNER_TEMP/certificate.p12"
    ;;
  delete)
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
    ;;
  *)
    echo "用法:tools/ci-keychain.sh import | delete" >&2
    exit 1
    ;;
esac
