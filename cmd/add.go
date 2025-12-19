package cmd

import (
	"fmt"
	"os"
	"strconv"

	"github.com/serhiitroinin/hostler/internal/hosts"
	"github.com/serhiitroinin/hostler/internal/nginx"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var addCmd = &cobra.Command{
	Use:   "add <domain> <port>",
	Short: "Add a new local domain",
	Long: `Add a new local domain pointing to a specific port.

Example:
  hostler add myapp.loc 3000
  hostler add api.loc 8080`,
	Args: cobra.ExactArgs(2),
	Run:  runAdd,
}

func runAdd(cmd *cobra.Command, args []string) {
	domain := args[0]
	port, err := strconv.Atoi(args[1])
	if err != nil || port < 1 || port > 65535 {
		color.Red("Error: Invalid port number: %s", args[1])
		os.Exit(1)
	}

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

	fmt.Printf("  nginx version: %s\n", cfg.Version)
	fmt.Printf("  config dir: %s\n", cfg.IncludeDir)

	// Check if nginx is running
	if !cfg.IsRunning {
		color.Yellow("Warning: nginx is not running")
		fmt.Print("  Start nginx? [y/N]: ")
		var answer string
		fmt.Scanln(&answer)
		if answer == "y" || answer == "Y" {
			if err := nginx.Start(); err != nil {
				color.Red("Error: %v", err)
				os.Exit(1)
			}
			color.Green("  nginx started")
		}
	} else {
		color.Green("  nginx is running")
	}

	fmt.Println()
	color.Cyan("Checking for conflicts...")

	// Read existing entries
	entries, err := nginx.ParseManagedConfig(cfg.ManagedConfPath)
	if err != nil {
		color.Red("Error: Failed to parse config: %v", err)
		os.Exit(1)
	}

	// Check for conflicts in our managed config
	for _, entry := range entries {
		if entry.Domain == domain {
			color.Red("Error: Domain '%s' already exists (port %d)", domain, entry.Port)
			color.Yellow("  Use 'hostler remove %s' first, or choose a different domain", domain)
			os.Exit(1)
		}
		if entry.Port == port {
			color.Red("Error: Port %d is already used by '%s'", port, entry.Domain)
			color.Yellow("  Use a different port or remove the existing domain first")
			os.Exit(1)
		}
	}

	// Check for conflicts in other nginx configs
	domainConflict, portConflict, err := nginx.FindConflicts(cfg.IncludeDir, domain, port, true)
	if err != nil {
		color.Yellow("Warning: Could not check for conflicts: %v", err)
	}
	if domainConflict != "" {
		color.Red("Error: Domain '%s' already configured in: %s", domain, domainConflict)
		os.Exit(1)
	}
	if portConflict != "" {
		color.Yellow("Warning: Port %d may conflict with config in: %s", port, portConflict)
	}

	// Check hosts file
	exists, err := hosts.HasDomain(hosts.GetHostsPath(), domain)
	if err != nil {
		color.Yellow("Warning: Could not check hosts file: %v", err)
	}
	if exists {
		color.Yellow("Warning: Domain '%s' already exists in /etc/hosts (will be updated)", domain)
	}

	color.Green("  No conflicts found")

	fmt.Println()
	color.Cyan("Updating configuration...")

	// Add to hosts file
	if err := hosts.AddEntry(hosts.GetHostsPath(), domain); err != nil {
		color.Red("Error: Failed to update hosts file: %v", err)
		os.Exit(1)
	}
	color.Green("  Updated /etc/hosts")

	// Add to nginx config
	entries = append(entries, nginx.DomainEntry{Domain: domain, Port: port})
	if err := nginx.WriteManagedConfig(cfg.ManagedConfPath, entries); err != nil {
		color.Red("Error: Failed to write nginx config: %v", err)
		os.Exit(1)
	}
	color.Green("  Updated nginx config")

	// Test nginx config
	if err := nginx.TestConfig(); err != nil {
		color.Red("Error: %v", err)
		color.Yellow("  Rolling back changes...")
		// Rollback: remove the entry we just added
		entries = entries[:len(entries)-1]
		nginx.WriteManagedConfig(cfg.ManagedConfPath, entries)
		hosts.RemoveEntry(hosts.GetHostsPath(), domain)
		os.Exit(1)
	}
	color.Green("  nginx config is valid")

	// Reload nginx
	if cfg.IsRunning {
		if err := nginx.Reload(); err != nil {
			color.Red("Error: %v", err)
			os.Exit(1)
		}
		color.Green("  nginx reloaded")
	}

	fmt.Println()
	color.Green("Successfully added %s -> localhost:%d", domain, port)
	fmt.Printf("\n  Access your app at: http://%s\n\n", domain)
}
