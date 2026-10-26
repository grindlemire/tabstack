#!/bin/sh
# Releases tabstack for Homebrew. Builds it for macOS and Linux, publishes
# the builds as a release on the tap (github.com/grindlemire/homebrew-tap),
# and points the tap's formula at them. Tags live on the tap,
# not here, so this repo needs none.
#
#   ./release.sh [-n] <version> [<tap clone>]
#
# -n builds the archives and the formula into a temporary folder, and stops
# there. The tap clone defaults to ~/code/personal/homebrew-tap.
set -eu

dry=
if [ "${1:-}" = -n ]; then
	dry=1
	shift
fi
v=${1:?usage: release.sh [-n] <version> [<tap clone>]}
tap=${2:-$HOME/code/personal/homebrew-tap}
here=$(cd "$(dirname "$0")" && pwd)
repo=grindlemire/homebrew-tap
tag=tabstack-v$v
out=$(mktemp -d)

build() {
	mkdir -p "$out/$1"
	GOOS=$2 GOARCH=$3 CGO_ENABLED=0 go build -C "$here" -trimpath \
		-ldflags "-s -w -X main.version=$v" -o "$out/$1/tabstack" .
}
platforms="darwin-arm64 darwin-amd64 linux-arm64 linux-amd64"
for p in $platforms; do
	build "$p" "${p%-*}" "${p#*-}"
	cp "$here/../../LICENSE" "$out/$p/"
	# COPYFILE_DISABLE keeps macOS's ._ files out
	COPYFILE_DISABLE=1 tar -C "$out/$p" -czf "$out/tabstack-$v-$p.tar.gz" tabstack LICENSE
done
sum() { shasum -a 256 "$out/tabstack-$v-$1.tar.gz" | cut -d' ' -f1; }
url=https://github.com/$repo/releases/download/$tag

cat >"$out/tabstack.rb" <<EOF
# Written by cmd/tabstack/release.sh in github.com/grindlemire/tabstack.
class Tabstack < Formula
  desc "Command-line tool and cross-profile helper for the tabstack browser extension"
  homepage "https://tabstack.alethi.dev"
  # brew would read 64 from the arm64 in its URL
  version "$v"
  license "MIT"

  on_macos do
    on_arm do
      url "$url/tabstack-$v-darwin-arm64.tar.gz"
      sha256 "$(sum darwin-arm64)"
    end
    on_intel do
      url "$url/tabstack-$v-darwin-amd64.tar.gz"
      sha256 "$(sum darwin-amd64)"
    end
  end

  on_linux do
    on_intel do
      url "$url/tabstack-$v-linux-amd64.tar.gz"
      sha256 "$(sum linux-amd64)"
    end
    on_arm do
      url "$url/tabstack-$v-linux-arm64.tar.gz"
      sha256 "$(sum linux-arm64)"
    end
  end

  def install
    bin.install "tabstack"
    generate_completions_from_executable(bin/"tabstack", "completion")
  end

  def caveats
    <<~EOS
      To connect tabstack in each of your browser profiles, run:
        tabstack install
      Before uninstalling, run tabstack uninstall to disconnect them.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tabstack version")
  end
end
EOF

if [ -n "$dry" ]; then
	echo "built into $out"
	exit 0
fi

gh release create "$tag" --repo "$repo" --title "tabstack $v" \
	--notes "tabstack $v. Install with: brew install grindlemire/tap/tabstack" \
	"$out"/tabstack-"$v"-*.tar.gz
mkdir -p "$tap/Formula"
cp "$out/tabstack.rb" "$tap/Formula/tabstack.rb"
git -C "$tap" add Formula/tabstack.rb
git -C "$tap" commit -m "tabstack $v"
git -C "$tap" push
rm -r "$out"
echo "released tabstack $v: brew install grindlemire/tap/tabstack"
