#!/bin/sh
set -eu

REPO="funny-dog/agent-cleaner"
INSTALL_DIR="${AGENT_CLEANER_INSTALL_DIR:-$HOME/.local/bin}"
LOCAL_MODE=0

for arg in "$@"; do
  case "$arg" in
    --local)
      LOCAL_MODE=1
      ;;
    -h|--help)
      cat <<'EOF'
Install agent-cleaner and ac CLI.

Usage:
  sh install.sh [--local]

Options:
  --local    Build (or reuse target/release/agent-cleaner) from the current repository
             and install into $AGENT_CLEANER_INSTALL_DIR (default: ~/.local/bin)

Environment variables:
  AGENT_CLEANER_INSTALL_DIR   Target directory (default: ~/.local/bin)
  AGENT_CLEANER_VERSION       Release tag to install (e.g. v0.2.3; default: latest)
  GITHUB_PROXY                Optional GitHub mirror prefix
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$INSTALL_DIR"
DEST_BIN="$INSTALL_DIR/agent-cleaner"
DEST_AC="$INSTALL_DIR/ac"

if [ "$LOCAL_MODE" -eq 1 ]; then
  if command -v cargo >/dev/null 2>&1 && [ -f "Cargo.toml" ]; then
    echo "Building cleaner-cli from local workspace..."
    cargo build --release -p cleaner-cli --bin agent-cleaner
  fi

  LOCAL_BIN="target/release/agent-cleaner"
  if [ ! -f "$LOCAL_BIN" ]; then
    echo "Error: $LOCAL_BIN not found. Run from repository root with Cargo installed." >&2
    exit 1
  fi

  cp "$LOCAL_BIN" "$DEST_BIN"
  chmod 755 "$DEST_BIN"
  ln -sf "$DEST_BIN" "$DEST_AC"
else
  OS_RAW="$(uname -s)"
  case "$OS_RAW" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    *)
      echo "Unsupported OS: $OS_RAW. Use install.ps1 on Windows." >&2
      exit 1
      ;;
  esac

  ARCH_RAW="$(uname -m)"
  case "$ARCH_RAW" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64) ARCH="x64" ;;
    *)
      echo "Unsupported CPU architecture: $ARCH_RAW" >&2
      exit 1
      ;;
  esac

  ASSET="agent-cleaner-${OS}-${ARCH}.tar.gz"
  VERSION="${AGENT_CLEANER_VERSION:-}"
  if [ -n "$VERSION" ]; then
    case "$VERSION" in
      v*) TAG="$VERSION" ;;
      *) TAG="v$VERSION" ;;
    esac
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
  else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
  fi

  PROXY="${GITHUB_PROXY:-${DSHM_GITHUB_PROXY:-}}"
  PROXY="${PROXY%/}"
  if [ -n "$PROXY" ]; then
    DOWNLOAD_URL="${PROXY}/${DOWNLOAD_URL}"
  fi

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

  ARCHIVE_PATH="$TMP_DIR/$ASSET"
  echo "Downloading ${ASSET} from ${DOWNLOAD_URL}..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$DOWNLOAD_URL" -o "$ARCHIVE_PATH"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$ARCHIVE_PATH" "$DOWNLOAD_URL"
  else
    echo "Error: curl or wget is required to download prebuilt binaries." >&2
    exit 1
  fi

  tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"
  if [ ! -f "$TMP_DIR/agent-cleaner" ]; then
    echo "Error: archive did not contain agent-cleaner binary." >&2
    exit 1
  fi

  cp "$TMP_DIR/agent-cleaner" "$DEST_BIN"
  chmod 755 "$DEST_BIN"
  ln -sf "$DEST_BIN" "$DEST_AC"
fi

echo "Installed: $DEST_BIN"
echo "Alias:     $DEST_AC -> $DEST_BIN"

case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    echo ""
    echo "Note: $INSTALL_DIR is not in your PATH."
    echo "Add this line to your shell profile (~/.zshrc or ~/.bashrc):"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Run 'ac' to launch the interactive wizard, or 'ac --help' for all commands."
