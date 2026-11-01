package main

import (
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
