package cmd

import (
	"fmt"
	"os"

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
	fmt.Printf("managed config: %s\n", cfg.ManagedConfPath)

	// Check if managed config exists
	if _, err := os.Stat(cfg.ManagedConfPath); err == nil {
		color.Green("managed file:   exists")
	} else {
		color.Yellow("managed file:   not created yet")
	}

	// Count domains
	entries, err := nginx.ParseManagedConfig(cfg.ManagedConfPath)
	if err != nil {
		fmt.Printf("domains:        error reading config\n")
	} else {
		fmt.Printf("domains:        %d\n", len(entries))
	}

	// Test config
	if err := nginx.TestConfig(); err != nil {
		color.Red("config valid:   no")
	} else {
		color.Green("config valid:   yes")
	}

	fmt.Println()
}
