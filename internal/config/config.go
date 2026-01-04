package config

import (
	"os"
	"os/user"
	"path/filepath"
)

const (
	// HostlerDir is the main hostler directory in user's home
	HostlerDir = ".hostler"
	// NginxSubdir is the subdirectory for nginx configs
	NginxSubdir = "nginx"
	// InitMarkerFile indicates successful initialization
	InitMarkerFile = ".initialized"
)

// GetUserConfigDir returns the user's hostler nginx config directory
// for the given home directory
func GetUserConfigDir(homeDir string) string {
	return filepath.Join(homeDir, HostlerDir, NginxSubdir)
}

// GetCurrentUserConfigDir returns config dir for current user
func GetCurrentUserConfigDir() string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	return GetUserConfigDir(u.HomeDir)
}

// IsInitialized checks if hostler has been initialized for the current user
func IsInitialized() bool {
	configDir := GetCurrentUserConfigDir()
	if configDir == "" {
		return false
	}

	// Check if directory exists
	if _, err := os.Stat(configDir); os.IsNotExist(err) {
		return false
	}

	// Check for init marker file
	markerPath := filepath.Join(configDir, InitMarkerFile)
	if _, err := os.Stat(markerPath); os.IsNotExist(err) {
		return false
	}

	return true
}

// WriteInitMarker creates the initialization marker file
func WriteInitMarker(configDir string) error {
	markerPath := filepath.Join(configDir, InitMarkerFile)
	return os.WriteFile(markerPath, []byte("initialized\n"), 0644)
}

// GetDomainConfigPath returns path for a domain's nginx config file
func GetDomainConfigPath(domain string) string {
	return filepath.Join(GetCurrentUserConfigDir(), domain+".conf")
}

// GetHostlerDir returns the main hostler directory path
func GetHostlerDir(homeDir string) string {
	return filepath.Join(homeDir, HostlerDir)
}
