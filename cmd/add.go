package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"github.com/serhiitroinin/hostler/internal/config"
	"github.com/serhiitroinin/hostler/internal/hosts"
	"github.com/serhiitroinin/hostler/internal/nginx"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

// getExecutablePath returns the absolute path to the current executable
func getExecutablePath() string {
	execPath, err := os.Executable()
	if err != nil {
		return "hostler"
	}
	// Resolve symlinks to get the real path
	if realPath, err := filepath.EvalSymlinks(execPath); err == nil {
		return realPath
	}
	return execPath
}

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

	// Check if hostler has been initialized
	if !config.IsInitialized() {
		color.Red("Error: hostler not initialized.")
		fmt.Println()
		fmt.Println("Run 'sudo hostler init' to set up hostler for passwordless operation.")
		os.Exit(1)
	}

	userConfigDir := config.GetCurrentUserConfigDir()

	fmt.Println()
	color.Cyan("Detecting nginx configuration...")

	// Detect nginx
	cfg, err := nginx.Detect()
	if err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}

	fmt.Printf("  nginx version: %s\n", cfg.Version)
	fmt.Printf("  config dir: %s\n", userConfigDir)

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

	// Read existing entries from user config directory
	entries, err := nginx.ParseUserConfigs(userConfigDir)
	if err != nil {
		color.Red("Error: Failed to parse configs: %v", err)
		os.Exit(1)
	}

	// Check for conflicts in our managed configs
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

	// Check for conflicts in system nginx configs
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

	// Write nginx config to user directory (no sudo needed)
	if err := nginx.WriteUserDomainConfig(userConfigDir, domain, port); err != nil {
		color.Red("Error: Failed to write nginx config: %v", err)
		os.Exit(1)
	}
	color.Green("  Created %s/%s.conf", userConfigDir, domain)

	// Add to hosts file via sudo (passwordless via sudoers)
	hostlerPath := getExecutablePath()
	hostsCmd := exec.Command("sudo", hostlerPath, "_hosts-add", domain)
	if output, err := hostsCmd.CombinedOutput(); err != nil {
		color.Red("Error: Failed to update hosts file: %v", err)
		if len(output) > 0 {
			fmt.Println(string(output))
		}
		// Rollback: remove the config file we just created
		nginx.RemoveUserDomainConfig(userConfigDir, domain)
		os.Exit(1)
	}
	color.Green("  Updated /etc/hosts (via sudo)")

	// Test nginx config via sudo
	testCmd := exec.Command("sudo", "nginx", "-t")
	if output, err := testCmd.CombinedOutput(); err != nil {
		color.Red("Error: nginx config test failed")
		fmt.Println(string(output))
		color.Yellow("  Rolling back changes...")
		// Rollback: remove config and hosts entry
		nginx.RemoveUserDomainConfig(userConfigDir, domain)
		exec.Command("sudo", hostlerPath, "_hosts-remove", domain).Run()
		os.Exit(1)
	}
	color.Green("  nginx config is valid")

	// Reload nginx via sudo
	if cfg.IsRunning {
		reloadCmd := exec.Command("sudo", "nginx", "-s", "reload")
		if output, err := reloadCmd.CombinedOutput(); err != nil {
			color.Red("Error: Failed to reload nginx")
			fmt.Println(string(output))
			os.Exit(1)
		}
		color.Green("  nginx reloaded")
	}

	fmt.Println()
	color.Green("Successfully added %s -> localhost:%d", domain, port)
	fmt.Printf("\n  Access your app at: http://%s\n\n", domain)
}
