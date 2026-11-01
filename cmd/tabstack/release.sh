#!/usr/bin/env bash
# Releases tabstack for Homebrew. Builds it for macOS and Linux, publishes
# the builds as a release on the tap (github.com/grindlemire/homebrew-tap),
# and points the tap's formula at them. Tags live on the tap,
# not here, so this repo needs none; the release notes name the commit.
#
#   ./release.sh [-n] <version> [<tap clone>]
#
# -n runs the tests, builds the archives and the formula into a temporary
# folder, and stops there. Without it, everything's checked before anything's
# published: this repo is committed and pushed, the tap clone is clean and up
# to date, and the release doesn't exist yet. The tap clone defaults to
# ~/code/personal/homebrew-tap.
set -euo pipefail

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
die() {
	echo "release.sh: $*" >&2
	exit 1
}

# 1.2.0, not v1.2.0: the tag adds the v
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version is like 1.2.0, not $v"
if [ -z "$dry" ]; then
	[ -z "$(git -C "$here" status --porcelain)" ] || die "commit your changes first"
	# the release notes link the commit on GitHub
	[ -n "$(git -C "$here" branch -r --contains HEAD)" ] || die "push this commit first"
	[ -z "$(git -C "$tap" status --porcelain)" ] || die "$tap has changes"
	git -C "$tap" pull --ff-only
	[ "$(git -C "$tap" rev-parse HEAD)" = "$(git -C "$tap" rev-parse '@{u}')" ] ||
		die "$tap has commits that aren't pushed"
	if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
		die "$tag is already released"
	fi
fi
go -C "$here" test ./...
commit=$(git -C "$here" rev-parse HEAD)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

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
	trap - EXIT
	echo "built into $out"
	exit 0
fi

# The formula's committed before the release, so a commit that fails stops
# it, and pushed after, so it never points at archives that aren't up yet.
mkdir -p "$tap/Formula"
cp "$out/tabstack.rb" "$tap/Formula/tabstack.rb"
git -C "$tap" add Formula/tabstack.rb
git -C "$tap" commit -m "tabstack $v"
gh release create "$tag" --repo "$repo" --title "tabstack $v" \
	--notes "tabstack $v, built from grindlemire/tabstack@$commit. Install with: brew install grindlemire/tap/tabstack" \
	"$out"/tabstack-"$v"-*.tar.gz || {
	git -C "$tap" reset -q --hard '@{u}'
	die "couldn't create the release; the tap is as it was"
}
git -C "$tap" push || die "released $tag, but couldn't push the formula: push $tap yourself"
echo "released tabstack $v: brew install grindlemire/tap/tabstack"
