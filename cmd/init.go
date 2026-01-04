package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"

	"github.com/serhiitroinin/hostler/internal/config"
	"github.com/serhiitroinin/hostler/internal/nginx"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize hostler for passwordless operation",
	Long: `Initialize hostler to allow add/remove commands without sudo.

This command requires root privileges and performs:
  1. Creates ~/.hostler/nginx/ directory for user configs
  2. Adds include directive to nginx.conf
  3. Sets up sudoers rules for specific operations

After initialization, you can use 'hostler add' and 'hostler remove'
without sudo.

Example:
  sudo hostler init`,
	Run: runInit,
}

func runInit(cmd *cobra.Command, args []string) {
	// Check root privileges
	if os.Geteuid() != 0 {
		color.Red("Error: This command requires root privileges. Please run with sudo.")
		os.Exit(1)
	}

	// Get the real user (not root)
	realUser := getRealUser()
	if realUser == nil {
		color.Red("Error: Could not determine user. Make sure to run with sudo, not as root directly.")
		os.Exit(1)
	}

	fmt.Println()
	fmt.Println("hostler init")
	fmt.Println("─────────────────────────────────────")

	// Step 1: Detect nginx
	color.Cyan("Detecting nginx...")
	cfg, err := nginx.Detect()
	if err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}
	fmt.Printf("  nginx version: %s\n", cfg.Version)
	fmt.Printf("  nginx config: %s\n", cfg.MainConfigPath)

	// Step 2: Create user config directory
	fmt.Println()
	color.Cyan("Creating user configuration directory...")
	userConfigDir := config.GetUserConfigDir(realUser.HomeDir)
	if err := createUserConfigDir(userConfigDir, realUser); err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}
	color.Green("  Created: %s", userConfigDir)

	// Step 3: Add include directive to nginx.conf
	fmt.Println()
	color.Cyan("Adding include directive to nginx.conf...")
	includeAdded, err := nginx.AddIncludeDirective(cfg.MainConfigPath, userConfigDir)
	if err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}
	if includeAdded {
		color.Green("  Added: include %s/*.conf;", userConfigDir)
	} else {
		color.Yellow("  Include directive already exists")
	}

	// Step 4: Test nginx configuration
	fmt.Println()
	color.Cyan("Testing nginx configuration...")
	if err := nginx.TestConfig(); err != nil {
		color.Red("Error: %v", err)
		// Rollback: remove include directive
		color.Yellow("  Rolling back changes...")
		nginx.RemoveIncludeDirective(cfg.MainConfigPath, userConfigDir)
		os.Exit(1)
	}
	color.Green("  nginx config is valid")

	// Step 5: Create sudoers file
	fmt.Println()
	color.Cyan("Setting up passwordless sudo...")
	if err := createSudoersFile(realUser.Username); err != nil {
		color.Red("Error: %v", err)
		// Rollback: remove include directive
		color.Yellow("  Rolling back changes...")
		nginx.RemoveIncludeDirective(cfg.MainConfigPath, userConfigDir)
		os.Exit(1)
	}
	color.Green("  Created: /etc/sudoers.d/hostler")

	// Step 6: Write init marker
	if err := config.WriteInitMarker(userConfigDir); err != nil {
		color.Yellow("Warning: Could not write init marker: %v", err)
	}

	// Success message
	fmt.Println()
	color.Green("Successfully initialized hostler!")
	fmt.Println()
	fmt.Println("You can now use these commands without sudo:")
	fmt.Println("  hostler add myapp.loc 3000")
	fmt.Println("  hostler remove myapp.loc")
	fmt.Println("  hostler list")
	fmt.Println()
}

// getRealUser returns the actual user who invoked sudo
func getRealUser() *user.User {
	// When running with sudo, get the real user from SUDO_USER
	sudoUser := os.Getenv("SUDO_USER")
	if sudoUser != "" {
		if u, err := user.Lookup(sudoUser); err == nil {
			return u
		}
	}

	// Fallback: check SUDO_UID
	sudoUID := os.Getenv("SUDO_UID")
	if sudoUID != "" {
		if u, err := user.LookupId(sudoUID); err == nil {
			return u
		}
	}

	return nil
}

// createUserConfigDir creates the user's hostler config directory
func createUserConfigDir(configDir string, realUser *user.User) error {
	// Create parent directory first
	parentDir := filepath.Dir(configDir)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Create the nginx config directory
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Change ownership to the real user
	uid, _ := strconv.Atoi(realUser.Uid)
	gid, _ := strconv.Atoi(realUser.Gid)

	if err := os.Chown(parentDir, uid, gid); err != nil {
		return fmt.Errorf("failed to set ownership: %w", err)
	}
	if err := os.Chown(configDir, uid, gid); err != nil {
		return fmt.Errorf("failed to set ownership: %w", err)
	}

	return nil
}

// createSudoersFile creates the sudoers file for passwordless operations
func createSudoersFile(username string) error {
	hostlerPath := getHostlerPath()
	nginxPath := getNginxPath()

	content := fmt.Sprintf(`# Sudoers rules for hostler CLI
# Generated by: sudo hostler init
# User: %s

# Allow hostler internal hosts commands
%s ALL=(root) NOPASSWD: %s _hosts-add *
%s ALL=(root) NOPASSWD: %s _hosts-remove *

# Allow nginx test and reload
%s ALL=(root) NOPASSWD: %s -t
%s ALL=(root) NOPASSWD: %s -s reload
`, username,
		username, hostlerPath,
		username, hostlerPath,
		username, nginxPath,
		username, nginxPath)

	sudoersPath := "/etc/sudoers.d/hostler"

	// Write with correct permissions (0440 is required for sudoers files)
	if err := os.WriteFile(sudoersPath, []byte(content), 0440); err != nil {
		return fmt.Errorf("failed to write sudoers file: %w", err)
	}

	// Validate sudoers syntax
	cmd := exec.Command("visudo", "-c", "-f", sudoersPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		os.Remove(sudoersPath)
		return fmt.Errorf("invalid sudoers syntax: %s", string(output))
	}

	return nil
}

// getHostlerPath returns the full path to the hostler binary
func getHostlerPath() string {
	// Try to find the actual binary path
	execPath, err := os.Executable()
	if err == nil {
		// Resolve symlinks to get the real path
		if realPath, err := filepath.EvalSymlinks(execPath); err == nil {
			return realPath
		}
		return execPath
	}

	// Fallback to common locations
	paths := []string{
		"/usr/local/bin/hostler",
		"/opt/homebrew/bin/hostler",
		"/usr/bin/hostler",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	return "hostler"
}

// getNginxPath returns the full path to the nginx binary
func getNginxPath() string {
	// Try to find nginx in PATH
	path, err := exec.LookPath("nginx")
	if err == nil {
		return path
	}

	// Fallback to common locations
	var paths []string
	if runtime.GOOS == "darwin" {
		paths = []string{
			"/opt/homebrew/bin/nginx",
			"/usr/local/bin/nginx",
		}
	} else {
		paths = []string{
			"/usr/sbin/nginx",
			"/usr/bin/nginx",
		}
	}

	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	return "nginx"
}
