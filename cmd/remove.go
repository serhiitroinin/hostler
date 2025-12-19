package cmd

import (
	"fmt"
	"os"

	"github.com/serhiitroinin/hostler/internal/hosts"
	"github.com/serhiitroinin/hostler/internal/nginx"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var removeCmd = &cobra.Command{
	Use:     "remove <domain>",
	Aliases: []string{"rm", "delete"},
	Short:   "Remove a local domain",
	Long: `Remove a local domain and its nginx configuration.

Example:
  hostler remove myapp.loc`,
	Args: cobra.ExactArgs(1),
	Run:  runRemove,
}

func runRemove(cmd *cobra.Command, args []string) {
	domain := args[0]

	// Check root privileges
	if os.Geteuid() != 0 {
		color.Red("Error: This command requires root privileges. Please run with sudo.")
		os.Exit(1)
	}

	fmt.Println()
	color.Cyan("Detecting nginx configuration...")

	// Detect nginx
	cfg, err := nginx.Detect()
	if err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}

	// Read existing entries
	entries, err := nginx.ParseManagedConfig(cfg.ManagedConfPath)
	if err != nil {
		color.Red("Error: Failed to parse config: %v", err)
		os.Exit(1)
	}

	// Check if domain exists
	found := nginx.FindEntry(entries, domain)
	if found == nil {
		color.Yellow("Domain '%s' is not managed by hostler", domain)
		os.Exit(1)
	}

	fmt.Printf("  Found: %s -> localhost:%d\n", domain, found.Port)

	fmt.Println()
	color.Cyan("Removing configuration...")

	// Remove from entries
	entries = nginx.RemoveEntry(entries, domain)

	// Write updated config
	if err := nginx.WriteManagedConfig(cfg.ManagedConfPath, entries); err != nil {
		color.Red("Error: Failed to write nginx config: %v", err)
		os.Exit(1)
	}
	color.Green("  Updated nginx config")

	// Remove from hosts file
	if err := hosts.RemoveEntry(hosts.GetHostsPath(), domain); err != nil {
		color.Red("Error: Failed to update hosts file: %v", err)
		os.Exit(1)
	}
	color.Green("  Updated /etc/hosts")

	// Test nginx config
	if err := nginx.TestConfig(); err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}
	color.Green("  nginx config is valid")

	// Reload nginx if running
	if cfg.IsRunning {
		if err := nginx.Reload(); err != nil {
			color.Red("Error: %v", err)
			os.Exit(1)
		}
		color.Green("  nginx reloaded")
	}

	fmt.Println()
	color.Green("Successfully removed %s", domain)
	fmt.Println()
}
