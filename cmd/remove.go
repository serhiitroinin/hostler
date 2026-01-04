package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/serhiitroinin/hostler/internal/config"
	"github.com/serhiitroinin/hostler/internal/nginx"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

// Note: getExecutablePath is defined in add.go

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

	// Read existing entries from user config directory
	entries, err := nginx.ParseUserConfigs(userConfigDir)
	if err != nil {
		color.Red("Error: Failed to parse configs: %v", err)
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

	// Remove nginx config file (no sudo needed - user-writable directory)
	if err := nginx.RemoveUserDomainConfig(userConfigDir, domain); err != nil {
		color.Red("Error: Failed to remove nginx config: %v", err)
		os.Exit(1)
	}
	color.Green("  Removed %s/%s.conf", userConfigDir, domain)

	// Remove from hosts file via sudo (passwordless via sudoers)
	hostlerPath := getExecutablePath()
	hostsCmd := exec.Command("sudo", hostlerPath, "_hosts-remove", domain)
	if output, err := hostsCmd.CombinedOutput(); err != nil {
		color.Red("Error: Failed to update hosts file: %v", err)
		if len(output) > 0 {
			fmt.Println(string(output))
		}
		os.Exit(1)
	}
	color.Green("  Updated /etc/hosts (via sudo)")

	// Test nginx config via sudo
	testCmd := exec.Command("sudo", "nginx", "-t")
	if output, err := testCmd.CombinedOutput(); err != nil {
		color.Red("Error: nginx config test failed")
		fmt.Println(string(output))
		os.Exit(1)
	}
	color.Green("  nginx config is valid")

	// Reload nginx if running via sudo
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
	color.Green("Successfully removed %s", domain)
	fmt.Println()
}
