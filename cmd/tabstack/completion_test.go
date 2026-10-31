package main

import (
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func scripts(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, shell := range []string{"bash", "zsh", "fish"} {
		var b strings.Builder
		if err := completion(&b, shell); err != nil {
			t.Fatal(err)
		}
		out[shell] = b.String()
	}
	return out
}

// Each shell parses its script, where the shell's here to ask.
func checkSyntax(t *testing.T, shell, script string) {
	t.Helper()
	flag := "-n"
	if shell == "fish" {
		flag = "--no-execute"
	}
	path, err := exec.LookPath(shell)
	if err != nil {
		return
	}
	cmd := exec.Command(path, flag)
	cmd.Stdin = strings.NewReader(script)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Errorf("%s can't parse its script: %v\n%s\n%s", shell, err, out, script)
	}
}

// A ' in what a command does ends the single-quoted string it's in, unless
// each shell's script escapes it its own way.
func TestCompletionQuoting(t *testing.T) {
	saved := commands
	t.Cleanup(func() { commands = saved })
	commands = []command{
		{name: "one", profiles: "all", help: "it's 'quoted'"},
		{name: "two", profiles: "first", help: "plain", about: "short's"},
		{name: "__hidden", hidden: true, help: "never shown"},
	}
	got := scripts(t)
	for shell, want := range map[string][]string{
		"bash": {`compgen -W "one two"`, "    one) ;;\n", "    two) (( COMP_CWORD == 2 ))"},
		"zsh":  {`'one:it'\''s '\''quoted'\'''`, `'two:short'\''s'`, "    one) ;;\n"},
		"fish": {`-a one -d 'it\'s \'quoted\''`, `-a two -d 'short\'s'`, "__fish_seen_subcommand_from one'"},
	} {
		for _, w := range want {
			if !strings.Contains(got[shell], w) {
				t.Errorf("the %s script doesn't have %q:\n%s", shell, w, got[shell])
			}
		}
		if strings.Contains(got[shell], "hidden") {
			t.Errorf("the %s script offers a hidden command:\n%s", shell, got[shell])
		}
		checkSyntax(t, shell, got[shell])
	}
}

// The usage text, the completion scripts and run all come from commands:
// each command that isn't hidden is in all of them, and run knows each
// command by every name it has.
func TestCommandsAgree(t *testing.T) {
	text := usage()
	got := scripts(t)
	bashNames := strings.Fields(regexp.MustCompile(`compgen -W "([^"]*)"`).FindStringSubmatch(got["bash"])[1])
	var names []string
	for _, c := range commands {
		if c.run == nil {
			t.Errorf("%s does nothing", c.name)
		}
		shown := map[string]bool{
			"usage": regexp.MustCompile(`(?m)^  tabstack ` + regexp.QuoteMeta(c.name) + `( |$)`).MatchString(text),
			"bash":  slices.Contains(bashNames, c.name),
			"zsh":   strings.Contains(got["zsh"], "'"+c.name+":"),
			"fish":  strings.Contains(got["fish"], "-a "+c.name+" -d"),
		}
		for where, ok := range shown {
			if ok == c.hidden {
				t.Errorf("%s: in the %s is %v, want %v", c.name, where, ok, !c.hidden)
			}
		}
		for _, n := range append([]string{c.name}, c.aliases...) {
			if slices.Contains(names, n) {
				t.Errorf("two commands are called %q", n)
			}
			names = append(names, n)
			if found, ok := lookup(n); !ok || found.name != c.name {
				t.Errorf("lookup(%q) = %q, %v; want %s", n, found.name, ok, c.name)
			}
			if n != c.name && strings.Contains(text, "tabstack "+n) {
				t.Errorf("the usage text shows the alias %s", n)
			}
		}
	}
	for shell, script := range got {
		checkSyntax(t, shell, script)
	}
}

func TestUnknownCommand(t *testing.T) {
	err := run([]string{"stauts"}, &strings.Builder{})
	if err == nil || !strings.HasPrefix(err.Error(), `unknown command "stauts"`) || !strings.Contains(err.Error(), "Usage:") {
		t.Errorf("run(stauts) = %v, want the usage text", err)
	}
}

// Commands that take no profiles, or only one kind, leave their arm out of
// each script: an empty one is a syntax error.
func TestCompletionWithoutProfiles(t *testing.T) {
	saved := commands
	t.Cleanup(func() { commands = saved })
	for _, c := range []struct {
		name     string
		profiles []string
	}{
		{"none", []string{"", ""}},
		{"only all", []string{"all", ""}},
		{"only first", []string{"", "first"}},
		{"all hidden", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			commands = []command{{name: "__hidden", hidden: true}}
			for i, p := range c.profiles {
				commands = append(commands, command{name: fmt.Sprintf("cmd%d", i), profiles: p, help: "x"})
			}
			for shell, script := range scripts(t) {
				if strings.Contains(script, "    ) ") || strings.Contains(script, "from '") || strings.Contains(script, "from ;") {
					t.Errorf("the %s script has an empty list:\n%s", shell, script)
				}
				checkSyntax(t, shell, script)
			}
		})
	}
}

// Every synopsis in the usage text has at least two spaces before what it
// does, or what it does goes below it.
func TestUsageColumns(t *testing.T) {
	text := usage()
	for _, c := range commands {
		if c.hidden {
			continue
		}
		synopsis := "  " + strings.TrimSpace("tabstack "+c.name+" "+c.args)
		i := strings.Index(text, synopsis)
		if i < 0 {
			t.Errorf("the usage text doesn't have %q", synopsis)
			continue
		}
		rest := text[i+len(synopsis):]
		if !strings.HasPrefix(rest, "\n") && !strings.HasPrefix(rest, "  ") {
			t.Errorf("%q runs into what it does: %q", synopsis, strings.SplitN(text[i:], "\n", 2)[0])
		}
	}
}

// A command run wrong says so one way: its line of the usage text.
func TestUsageErrors(t *testing.T) {
	isolate(t)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"connect"}, "usage: tabstack connect <profile>... (tabstack list shows the profiles)"},
		{[]string{"disconnect"}, "usage: tabstack disconnect --all|<profile>... (tabstack list shows the profiles)"},
		{[]string{"reset"}, "usage: tabstack reset <profile>..."},
		{[]string{"rename", "1"}, "usage: tabstack rename <profile> <name>"},
		{[]string{"links"}, "usage: tabstack links <profile> [add|remove <pattern>...]"},
		{[]string{"links", "1", "add"}, "usage: tabstack links"},
		{[]string{"focus"}, "usage: tabstack focus <profile> [<tab>]"},
		{[]string{"open"}, "usage: tabstack open [--profile <profile>] <link>..."},
		{[]string{"completion"}, "usage: tabstack completion bash|zsh|fish"},
	} {
		err := run(c.args, io.Discard)
		if err == nil || !strings.HasPrefix(err.Error(), c.want) {
			t.Errorf("%q: %v, want %q", c.args, err, c.want)
		}
	}
}
