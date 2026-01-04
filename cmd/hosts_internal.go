package cmd

import (
	"os"
	"regexp"

	"github.com/serhiitroinin/hostler/internal/hosts"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

// hostsAddCmd is an internal command for adding domains to /etc/hosts
// It is hidden from help output and designed to be called via sudo
var hostsAddCmd = &cobra.Command{
	Use:    "_hosts-add <domain>",
	Short:  "Internal: Add domain to /etc/hosts",
	Hidden: true,
	Args:   cobra.ExactArgs(1),
	Run:    runHostsAdd,
}

// hostsRemoveCmd is an internal command for removing domains from /etc/hosts
// It is hidden from help output and designed to be called via sudo
var hostsRemoveCmd = &cobra.Command{
	Use:    "_hosts-remove <domain>",
	Short:  "Internal: Remove domain from /etc/hosts",
	Hidden: true,
	Args:   cobra.ExactArgs(1),
	Run:    runHostsRemove,
}

func runHostsAdd(cmd *cobra.Command, args []string) {
	domain := args[0]

	// Validate domain format for security
	if !isValidDomain(domain) {
		color.Red("Error: Invalid domain format")
		os.Exit(1)
	}

	// Check root privileges (required for /etc/hosts)
	if os.Geteuid() != 0 {
		color.Red("Error: This command requires root privileges")
		os.Exit(1)
	}

	// Add to hosts file
	if err := hosts.AddEntry(hosts.GetHostsPath(), domain); err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}
}

func runHostsRemove(cmd *cobra.Command, args []string) {
	domain := args[0]

	// Validate domain format for security
	if !isValidDomain(domain) {
		color.Red("Error: Invalid domain format")
		os.Exit(1)
	}

	// Check root privileges (required for /etc/hosts)
	if os.Geteuid() != 0 {
		color.Red("Error: This command requires root privileges")
		os.Exit(1)
	}

	// Remove from hosts file
	if err := hosts.RemoveEntry(hosts.GetHostsPath(), domain); err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}
}

// isValidDomain validates domain format for security
// Only allows: letters, numbers, dots, hyphens
// Must have at least one dot (e.g., "app.loc")
func isValidDomain(domain string) bool {
	// Length check
	if len(domain) > 253 || len(domain) < 3 {
		return false
	}

	// Pattern: starts and ends with alphanumeric, allows hyphens in middle
	// Must contain at least one dot
	validDomain := regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$`)
	return validDomain.MatchString(domain)
}
