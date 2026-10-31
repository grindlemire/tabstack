// Command tabstack is the command line for the tabstack extension, and the
// helper that lets it work across browser profiles.
//
// Each profile runs its own copy of the extension, and extensions can't talk
// across profiles, so each copy connects to this helper over native messaging.
// The browser starts one helper per profile; the first becomes the hub the
// others join, and passes messages between them (hub.go). What the profiles
// say to each other is up to the extension (src/background/profiles.ts).
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

// command is one of tabstack's commands. The usage text, the shell
// completion scripts and run all come from the list of them.
type command struct {
	name     string
	args     string   // after its name, in the usage text
	help     string   // in the usage text, a line per line
	about    string   // in shell completion, one short line; help if empty
	profiles string   // which arguments are profiles, to complete: "all", "first" or ""
	gap      bool     // a blank line before it in the usage text
	hidden   bool     // left out of the usage text and completion
	aliases  []string // other names that run it, never shown
	run      func(w io.Writer, args []string) error
}

var commands []command

// commands is set here, not where it's declared, since help and completion
// read it.
func init() {
	commands = []command{
		{name: "install", run: runInstall,
			help:  "find tabstack in every profile, register the\nhelper, and connect each profile",
			about: "find tabstack in every profile and connect each"},
		{name: "list", aliases: []string{"status"}, run: noArgs(list),
			help:  "every profile, numbered, and how it's connected",
			about: "every profile, and how it's connected"},
		{name: "connect", args: "<profile>...", profiles: "all", run: needsProfile("connect", connect),
			help:  "connect profiles (one click in each)",
			about: "connect profiles"},
		{name: "disconnect", args: "--all|<profile>...", profiles: "all", run: runDisconnect,
			help:  "stop profiles connecting, or every one",
			about: "stop profiles connecting"},
		{name: "reset", args: "<profile>...", profiles: "all", run: needsProfile("reset", reset),
			help:  "clear a profile's name and links, and reconnect it",
			about: "clear a profile's name and links"},
		{name: "rename", args: "<profile> <name>", profiles: "first", run: runRename,
			help: "change the name other profiles show"},
		{name: "links", args: "<profile> [add|remove <pattern>...]", profiles: "first", run: links,
			help: "the links that open in a profile"},
		{name: "uninstall", run: noArgs(uninstall),
			help: "disconnect every profile and unregister the helper"},

		{name: "open", args: "[--profile <profile>] <link>...", gap: true, run: open,
			help: "open links in the profile they belong to"},
		{name: "tabs", args: "[--json] [<words>]", run: tabs,
			help: "every profile's tabs, most recent first"},
		{name: "focus", args: "<profile> [<tab>]", profiles: "first", run: focus,
			help: "bring a profile forward, or one of its tabs"},

		{name: "doctor", gap: true, run: noArgs(doctor),
			help: "check the setup, and fix what it can"},
		{name: "completion", args: "bash|zsh|fish", run: runCompletion,
			help:  "shell completion for these commands",
			about: "shell completion for bash, zsh or fish"},
		{name: "version", aliases: []string{"--version"}, run: printVersion,
			help: "which version this is"},

		{name: "help", aliases: []string{"-h", "--help"}, hidden: true, run: printUsage},
		{name: "__profiles", hidden: true, run: noArgs(completeProfiles)}, // for the completion scripts
	}
}

const usageHead = `tabstack is the command line for the tabstack browser extension,
and the helper that lets it work across your browser profiles.

Usage:
`

const usageTail = `
A <profile> is its number from list, its name, or its folder ("Profile 1").

install finds tabstack, from the Chrome Web Store or loaded unpacked, in each
profile of Chrome, Brave, Edge, Chromium and Vivaldi. For a copy it can't find,
pass --extension-id with the ID from chrome://extensions (repeatable), and
again each time you run install: it lets in only the copies it finds and the
IDs it's given. Connecting needs one click in each profile, since Chrome only
grants the permission there.
`

// usageColumn is where the usage text's descriptions start.
const usageColumn = 36

// usage is the usage text: each command that isn't hidden, with what it does
// beside it, or below it when it's too long.
func usage() string {
	var b strings.Builder
	b.WriteString(usageHead)
	for _, c := range commands {
		if c.hidden {
			continue
		}
		if c.gap {
			b.WriteString("\n")
		}
		synopsis := strings.TrimSpace("tabstack " + c.name + " " + c.args)
		lines := strings.Split(c.help, "\n")
		// at least two spaces between them, so neither reads into the other
		if len(synopsis) <= usageColumn-4 {
			fmt.Fprintf(&b, "  %-*s%s\n", usageColumn-2, synopsis, lines[0])
			lines = lines[1:]
		} else {
			fmt.Fprintf(&b, "  %s\n", synopsis)
		}
		for _, l := range lines {
			fmt.Fprintf(&b, "%*s%s\n", usageColumn, "", l)
		}
	}
	b.WriteString(usageTail)
	return b.String()
}

// lookup finds a command by its name or an alias.
func lookup(name string) (command, bool) {
	for _, c := range commands {
		if c.name == name || slices.Contains(c.aliases, name) {
			return c, true
		}
	}
	return command{}, false
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "tabstack:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	// A browser starts the helper with the calling extension's origin as the
	// first argument.
	if len(args) > 0 && strings.HasPrefix(args[0], "chrome-extension://") {
		return runHost()
	}

	name := "help"
	if len(args) > 0 {
		name, args = args[0], args[1:]
	}
	c, ok := lookup(name)
	if !ok {
		return fmt.Errorf("unknown command %q\n\n%s", name, usage())
	}
	return c.run(stdout, args)
}

// noArgs adapts a command that takes no arguments; any given are ignored.
func noArgs(f func(io.Writer) error) func(io.Writer, []string) error {
	return func(w io.Writer, _ []string) error { return f(w) }
}

func needsProfile(name string, f func(io.Writer, []string) error) func(io.Writer, []string) error {
	return func(w io.Writer, args []string) error {
		if len(args) == 0 {
			return usageError(name)
		}
		return f(w, args)
	}
}

// usageError is what every command says when it's run wrong: its line of
// the usage text, and for one that takes profiles, where to find them.
func usageError(name string) error {
	c, _ := lookup(name)
	msg := "usage: " + strings.TrimSpace("tabstack "+c.name+" "+c.args)
	if c.profiles != "" {
		msg += " (tabstack list shows the profiles)"
	}
	return errors.New(msg)
}

// parseFlags parses a command's flags, and says whether to stop there: on
// a mistake, and on -h, which prints them and isn't one. Go's flag stops at
// the first argument that isn't a flag, so a flag after it (tabstack open
// corp.com --profile Work) would be taken for one of the rest; it's
// refused, by what the rest are.
func parseFlags(fs *flag.FlagSet, args []string, rest string) (stop bool, err error) {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return true, nil
		}
		return true, err
	}
	for _, a := range fs.Args()[min(1, fs.NArg()):] {
		if len(a) > 1 && strings.HasPrefix(a, "-") {
			return true, fmt.Errorf("%s: flags go before the %s", a, rest)
		}
	}
	return false, nil
}

func runInstall(w io.Writer, args []string) error {
	var ids []string
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.Func("extension-id", "allow this extension ID (repeatable)", func(s string) error {
		if err := checkExtensionID(s); err != nil {
			return err
		}
		ids = append(ids, s)
		return nil
	})
	if stop, err := parseFlags(fs, args, "rest"); stop {
		return err
	}
	return install(w, ids)
}

func runDisconnect(w io.Writer, args []string) error {
	all := slices.Contains(args, "--all")
	args = slices.DeleteFunc(args, func(a string) bool { return a == "--all" })
	if len(args) == 0 && !all {
		return usageError("disconnect")
	}
	_, err := disconnect(w, args, all)
	return err
}

func runRename(w io.Writer, args []string) error {
	if len(args) != 2 {
		return usageError("rename")
	}
	return rename(w, args[0], args[1])
}

func runCompletion(w io.Writer, args []string) error {
	if len(args) != 1 {
		return usageError("completion")
	}
	return completion(w, args[0])
}

func printUsage(w io.Writer, _ []string) error {
	fmt.Fprint(w, usage())
	return nil
}

func printVersion(w io.Writer, _ []string) error {
	fmt.Fprintln(w, "tabstack", version)
	return nil
}
