package main

import (
	"cmp"
	"fmt"
	"io"
	"slices"
	"strings"
)

// completion prints the script that completes these commands in a shell,
// for Homebrew to install or to source from a shell's startup file.
func completion(w io.Writer, shell string) error {
	var names, all, first, described, fish string
	for _, c := range commands {
		if c.hidden {
			continue
		}
		about := cmp.Or(c.about, c.help)
		names += " " + c.name
		// a ' ends a single-quoted string, in zsh by '\'' and in fish by \'
		described += fmt.Sprintf("\n    '%s:%s'", c.name, strings.ReplaceAll(about, "'", `'\''`))
		fish += fmt.Sprintf("complete -c tabstack -n __fish_use_subcommand -a %s -d '%s'\n", c.name, strings.ReplaceAll(about, "'", `\'`))
		switch c.profiles {
		case "all":
			all += "|" + c.name
		case "first":
			first += "|" + c.name
		}
	}
	all, first = all[1:], first[1:]
	switch shell {
	case "bash":
		fmt.Fprintf(w, bashCompletion, names[1:], all, first)
	case "zsh":
		fmt.Fprintf(w, zshCompletion, described, all, first)
	case "fish":
		fmt.Fprint(w, fish)
		fmt.Fprintf(w, fishProfiles, strings.ReplaceAll(all, "|", " "), strings.ReplaceAll(first, "|", " "))
	default:
		return fmt.Errorf("completion is for bash, zsh or fish, not %q", shell)
	}
	return nil
}

// completeProfiles prints what each profile can be called, one per line,
// for the completion scripts.
func completeProfiles(w io.Writer) error {
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()
	var seen []string
	for _, e := range s.entries {
		if e.p.id == "" && e.peer == nil {
			continue
		}
		if name := e.name(); !slices.Contains(seen, name) {
			seen = append(seen, name)
			fmt.Fprintln(w, name)
		}
	}
	return nil
}

const bashCompletion = `_tabstack() {
  local cur=${COMP_WORDS[COMP_CWORD]}
  if (( COMP_CWORD == 1 )); then
    COMPREPLY=($(compgen -W "%s" -- "$cur"))
    return
  fi
  case ${COMP_WORDS[1]} in
    %s) ;;
    %s) (( COMP_CWORD == 2 )) || return ;;
    completion) COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur")); return ;;
    *) return ;;
  esac
  local IFS=$'\n' name
  COMPREPLY=()
  # one at a time: macOS's bash 3.2 joins "${a[@]// /\\ }" into one word
  for name in $(compgen -W "$(tabstack __profiles 2>/dev/null)" -- "$cur"); do
    COMPREPLY+=("${name// /\\ }")
  done
}
complete -F _tabstack tabstack
`

const zshCompletion = `#compdef tabstack

_tabstack() {
  local -a commands profiles
  commands=(%s
  )
  if (( CURRENT == 2 )); then
    _describe command commands
    return
  fi
  case $words[2] in
    %s) ;;
    %s) (( CURRENT == 3 )) || return ;;
    completion) compadd bash zsh fish; return ;;
    *) return ;;
  esac
  profiles=("${(@f)$(tabstack __profiles 2>/dev/null)}")
  compadd -a profiles
}

if [ "$funcstack[1]" = "_tabstack" ]; then
  _tabstack "$@"
else
  compdef _tabstack tabstack
fi
`

const fishProfiles = `complete -c tabstack -f
complete -c tabstack -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c tabstack -n '__fish_seen_subcommand_from %s' -a '(tabstack __profiles 2>/dev/null)'
complete -c tabstack -n '__fish_seen_subcommand_from %s; and test (count (commandline -opc)) -eq 2' -a '(tabstack __profiles 2>/dev/null)'
`
