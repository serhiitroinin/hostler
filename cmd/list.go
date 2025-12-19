package cmd

import (
	"fmt"
	"net"
	"os"
	"time"

	"github.com/serhiitroinin/hostler/internal/nginx"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"
	"github.com/spf13/cobra"
)

var listCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all managed local domains",
	Long:    `Display all local domains managed by hostler in a table format.`,
	Run:     runList,
}

func runList(cmd *cobra.Command, args []string) {
	fmt.Println()

	// Detect nginx
	cfg, err := nginx.Detect()
	if err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}

	// Read entries
	entries, err := nginx.ParseManagedConfig(cfg.ManagedConfPath)
	if err != nil {
		color.Red("Error: Failed to parse config: %v", err)
		os.Exit(1)
	}

	if len(entries) == 0 {
		color.Yellow("No domains configured yet.")
		fmt.Println()
		fmt.Println("Add a domain with:")
		fmt.Println("  sudo hostler add myapp.loc 3000")
		fmt.Println()
		return
	}

	// Create table
	table := tablewriter.NewWriter(os.Stdout)
	table.SetHeader([]string{"Domain", "Port", "URL", "Status"})
	table.SetBorder(true)
	table.SetRowLine(false)
	table.SetHeaderColor(
		tablewriter.Colors{tablewriter.Bold, tablewriter.FgCyanColor},
		tablewriter.Colors{tablewriter.Bold, tablewriter.FgCyanColor},
		tablewriter.Colors{tablewriter.Bold, tablewriter.FgCyanColor},
		tablewriter.Colors{tablewriter.Bold, tablewriter.FgCyanColor},
	)
	table.SetColumnColor(
		tablewriter.Colors{tablewriter.FgWhiteColor},
		tablewriter.Colors{tablewriter.FgYellowColor},
		tablewriter.Colors{tablewriter.FgHiBlueColor},
		tablewriter.Colors{},
	)
	table.SetCenterSeparator("|")
	table.SetColumnSeparator("|")
	table.SetRowSeparator("-")

	for _, entry := range entries {
		status := checkPortStatus(entry.Port)
		statusColor := "down"
		if status == "up" {
			statusColor = color.GreenString("up")
		} else {
			statusColor = color.RedString("down")
		}

		table.Append([]string{
			entry.Domain,
			fmt.Sprintf("%d", entry.Port),
			fmt.Sprintf("http://%s", entry.Domain),
			statusColor,
		})
	}

	table.Render()
	fmt.Printf("\n  Total: %d domain(s)\n", len(entries))
	fmt.Printf("  Config: %s\n\n", cfg.ManagedConfPath)
}

func checkPortStatus(port int) string {
	address := fmt.Sprintf("127.0.0.1:%d", port)
	conn, err := net.DialTimeout("tcp", address, 500*time.Millisecond)
	if err != nil {
		return "down"
	}
	conn.Close()
	return "up"
}
