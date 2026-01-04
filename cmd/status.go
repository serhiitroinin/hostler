package cmd

import (
	"fmt"
	"os"

	"github.com/serhiitroinin/hostler/internal/config"
	"github.com/serhiitroinin/hostler/internal/nginx"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show hostler and nginx status",
	Long:  `Display detailed status information about nginx and hostler configuration.`,
	Run:   runStatus,
}

func runStatus(cmd *cobra.Command, args []string) {
	fmt.Println()
	fmt.Println("hostler status")
	fmt.Println("─────────────────────────────────────")

	// Detect nginx
	cfg, err := nginx.Detect()
	if err != nil {
		color.Red("nginx:          not found")
		fmt.Printf("error:          %v\n", err)
		fmt.Println()
		os.Exit(1)
	}

	// nginx status
	if cfg.IsRunning {
		color.Green("nginx:          running")
	} else {
		color.Red("nginx:          stopped")
	}

	fmt.Printf("nginx version:  %s\n", cfg.Version)
	fmt.Printf("nginx config:   %s\n", cfg.MainConfigPath)
	fmt.Printf("include dir:    %s\n", cfg.IncludeDir)

	fmt.Println()

	// hostler status
	if config.IsInitialized() {
		color.Green("hostler mode:   initialized")
		userConfigDir := config.GetCurrentUserConfigDir()
		fmt.Printf("user config:    %s\n", userConfigDir)

		// Check if sudoers file exists
		if _, err := os.Stat("/etc/sudoers.d/hostler"); err == nil {
			color.Green("sudoers:        configured")
		} else {
			color.Yellow("sudoers:        not found")
		}

		// Check if include directive exists
		if nginx.HasIncludeDirective(cfg.MainConfigPath, userConfigDir) {
			color.Green("nginx include:  configured")
		} else {
			color.Yellow("nginx include:  not found")
		}

		// Count domains
		entries, err := nginx.ParseUserConfigs(userConfigDir)
		if err != nil {
			fmt.Printf("domains:        error reading configs\n")
		} else {
			fmt.Printf("domains:        %d\n", len(entries))
		}
	} else {
		color.Yellow("hostler mode:   not initialized")
		fmt.Println()
		fmt.Println("Run 'sudo hostler init' to set up hostler for passwordless operation.")
	}

	// Test config
	fmt.Println()
	if err := nginx.TestConfig(); err != nil {
		color.Red("config valid:   no")
	} else {
		color.Green("config valid:   yes")
	}

	fmt.Println()
}
