// Command tabstack-host lets tabstack switch between browser profiles.
//
// Each profile runs its own copy of the extension, and extensions can't talk
// across profiles, so each copy connects to this helper over native messaging.
// The browser starts one helper per profile; the first becomes the hub the
// others join, and passes messages between them (hub.go). What the profiles
// say to each other is up to the extension (src/profiles.js).
//
// It only uses the standard library, and runs on macOS and Linux.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

const usage = `tabstack-host lets tabstack work across your browser profiles.

Usage:
  tabstack-host install                  find tabstack in every profile, register the
                                         helper, and connect each profile
  tabstack-host list                     every profile, numbered, and how it's connected
  tabstack-host connect <profile>...     connect profiles (one click in each)
  tabstack-host disconnect <profile>...  stop profiles connecting; --all for every one
  tabstack-host reset <profile>...       clear a profile's name and links, and reconnect it
  tabstack-host rename <profile> <name>  change the name other profiles show
  tabstack-host links <profile> [add|remove <pattern>...]
                                         the links that open in a profile
  tabstack-host uninstall                disconnect every profile and unregister the helper

  tabstack-host open [--profile <profile>] <link>...
                                         open links in the profile they belong to
  tabstack-host tabs [--json] [<words>]  every profile's tabs, most recent first
  tabstack-host focus <profile> [<tab>]  bring a profile forward, or one of its tabs

  tabstack-host doctor                   check the setup, and fix what it can
  tabstack-host completion bash|zsh|fish shell completion for these commands
  tabstack-host version                  which tabstack-host this is

A <profile> is its number from list, its name, or its folder ("Profile 1").

install finds tabstack by its name in each profile of Chrome, Brave, Edge,
Chromium and Vivaldi. For a copy it can't find, pass --extension-id with the ID
from chrome://extensions (repeatable). Connecting needs one click in each
profile, since Chrome only grants the permission there.
`

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "tabstack-host:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	// A browser starts the helper with the calling extension's origin as the
	// first argument.
	if len(args) > 0 && strings.HasPrefix(args[0], "chrome-extension://") {
		return runHost()
	}

	cmd := ""
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "install":
		var ids []string
		fs := flag.NewFlagSet("install", flag.ContinueOnError)
		fs.Func("extension-id", "allow this extension ID (repeatable)", func(s string) error {
			ids = append(ids, s)
			return nil
		})
		if err := fs.Parse(args); err != nil {
			return err
		}
		return install(stdout, ids)
	case "list", "status":
		return list(stdout)
	case "connect", "reset":
		if len(args) == 0 {
			return fmt.Errorf("%s needs a profile; run tabstack-host list to see them", cmd)
		}
		if cmd == "connect" {
			return connect(stdout, args)
		}
		return reset(stdout, args)
	case "disconnect":
		all := slices.Contains(args, "--all")
		args = slices.DeleteFunc(args, func(a string) bool { return a == "--all" })
		if len(args) == 0 && !all {
			return errors.New("disconnect needs a profile, or --all; run tabstack-host list to see them")
		}
		_, err := disconnect(stdout, args, all)
		return err
	case "rename":
		if len(args) != 2 {
			return errors.New("tabstack-host rename <profile> <name>")
		}
		return rename(stdout, args[0], args[1])
	case "links":
		return links(stdout, args)
	case "uninstall":
		return uninstall(stdout)
	case "doctor":
		return doctor(stdout)
	case "completion":
		if len(args) != 1 {
			return errors.New("tabstack-host completion bash|zsh|fish")
		}
		return completion(stdout, args[0])
	case "__profiles":
		return completeProfiles(stdout)
	case "open":
		return open(stdout, args)
	case "tabs":
		return tabs(stdout, args)
	case "focus":
		return focus(stdout, args)
	case "version", "--version":
		fmt.Fprintln(stdout, "tabstack-host", version)
		return nil
	case "", "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q\n\n%s", cmd, usage)
	}
}
