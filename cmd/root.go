package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var version = "dev"

var rootCmd = &cobra.Command{
	Use:   "hostler",
	Short: "Manage local development domains with nginx",
	Long: `Hostler is a CLI tool that manages local development domains.
It automatically creates nginx reverse proxy configurations and updates /etc/hosts.

Example:
  hostler add myapp.loc 3000
  hostler list
  hostler remove myapp.loc`,
	Version: version,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(addCmd)
	rootCmd.AddCommand(removeCmd)
	rootCmd.AddCommand(listCmd)
	rootCmd.AddCommand(statusCmd)
}
