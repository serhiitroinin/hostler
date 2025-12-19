package nginx

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const ManagedConfigName = "hostler-managed.conf"

// Config holds nginx installation information
type Config struct {
	MainConfigPath  string
	IncludeDir      string
	ManagedConfPath string
	IsRunning       bool
	Version         string
}

// DomainEntry represents a single domain-to-port mapping
type DomainEntry struct {
	Domain string
	Port   int
}

// Detect finds nginx installation and configuration paths
func Detect() (*Config, error) {
	cfg := &Config{}

	// Check if nginx is running
	cfg.IsRunning = isNginxRunning()

	// Get nginx version and config path
	version, configPath, err := getNginxInfo()
	if err != nil {
		return nil, fmt.Errorf("nginx not found: %w", err)
	}
	cfg.Version = version
	cfg.MainConfigPath = configPath

	// Find include directory
	includeDir, err := findIncludeDir(configPath)
	if err != nil {
		return nil, err
	}
	cfg.IncludeDir = includeDir
	cfg.ManagedConfPath = filepath.Join(includeDir, ManagedConfigName)

	return cfg, nil
}

func isNginxRunning() bool {
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("pgrep", "nginx")
	} else {
		cmd = exec.Command("pgrep", "-x", "nginx")
	}
	return cmd.Run() == nil
}

func getNginxInfo() (version, configPath string, err error) {
	// Run nginx -V to get version and config path
	cmd := exec.Command("nginx", "-V")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Run() // Ignore error, nginx -V writes to stderr

	output := stderr.String()

	// Extract version
	versionRe := regexp.MustCompile(`nginx version: nginx/([^\s]+)`)
	if matches := versionRe.FindStringSubmatch(output); len(matches) > 1 {
		version = matches[1]
	}

	// Extract config path from --conf-path
	confRe := regexp.MustCompile(`--conf-path=([^\s]+)`)
	if matches := confRe.FindStringSubmatch(output); len(matches) > 1 {
		configPath = matches[1]
	} else {
		// Fall back to common locations
		configPath = findConfigFile()
	}

	if configPath == "" {
		return "", "", fmt.Errorf("could not determine nginx config path")
	}

	return version, configPath, nil
}

func findConfigFile() string {
	paths := []string{
		"/opt/homebrew/etc/nginx/nginx.conf", // Apple Silicon
		"/usr/local/etc/nginx/nginx.conf",    // Intel Mac
		"/etc/nginx/nginx.conf",              // Linux
		"/usr/local/nginx/conf/nginx.conf",   // Custom install
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func findIncludeDir(configPath string) (string, error) {
	configDir := filepath.Dir(configPath)

	// Check common include directories
	candidates := []string{
		filepath.Join(configDir, "servers"),       // macOS Homebrew
		filepath.Join(configDir, "sites-enabled"), // Debian/Ubuntu
		filepath.Join(configDir, "conf.d"),        // CentOS/RHEL
	}

	for _, dir := range candidates {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir, nil
		}
	}

	// Create servers directory if on macOS
	if runtime.GOOS == "darwin" {
		serversDir := filepath.Join(configDir, "servers")
		if err := os.MkdirAll(serversDir, 0755); err != nil {
			return "", fmt.Errorf("could not create include directory: %w", err)
		}
		return serversDir, nil
	}

	// Create conf.d if nothing exists
	confD := filepath.Join(configDir, "conf.d")
	if err := os.MkdirAll(confD, 0755); err != nil {
		return "", fmt.Errorf("could not create include directory: %w", err)
	}

	return confD, nil
}

// TestConfig runs nginx -t to validate configuration
func TestConfig() error {
	cmd := exec.Command("nginx", "-t")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("nginx config test failed:\n%s", string(output))
	}
	return nil
}

// Reload sends reload signal to nginx
func Reload() error {
	cmd := exec.Command("nginx", "-s", "reload")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("nginx reload failed:\n%s", string(output))
	}
	return nil
}

// Start starts nginx
func Start() error {
	if runtime.GOOS == "darwin" {
		// Try brew services first
		cmd := exec.Command("brew", "services", "start", "nginx")
		if err := cmd.Run(); err == nil {
			return nil
		}
	}

	cmd := exec.Command("nginx")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to start nginx:\n%s", string(output))
	}
	return nil
}

// Stop stops nginx
func Stop() error {
	if runtime.GOOS == "darwin" {
		// Try brew services first
		cmd := exec.Command("brew", "services", "stop", "nginx")
		if err := cmd.Run(); err == nil {
			return nil
		}
	}

	cmd := exec.Command("nginx", "-s", "stop")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to stop nginx:\n%s", string(output))
	}
	return nil
}

// ParseManagedConfig reads the managed config file and returns all entries
func ParseManagedConfig(path string) ([]DomainEntry, error) {
	var entries []DomainEntry

	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return entries, nil // No config yet
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var currentDomain string
	serverNameRe := regexp.MustCompile(`server_name\s+([^;]+);`)
	proxyPassRe := regexp.MustCompile(`proxy_pass\s+http://127\.0\.0\.1:(\d+);`)

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		if matches := serverNameRe.FindStringSubmatch(line); len(matches) > 1 {
			currentDomain = strings.TrimSpace(matches[1])
		}

		if matches := proxyPassRe.FindStringSubmatch(line); len(matches) > 1 {
			var port int
			fmt.Sscanf(matches[1], "%d", &port)
			if currentDomain != "" && port > 0 {
				entries = append(entries, DomainEntry{
					Domain: currentDomain,
					Port:   port,
				})
				currentDomain = ""
			}
		}
	}

	return entries, scanner.Err()
}

// GenerateServerBlock creates nginx server block for a domain
func GenerateServerBlock(domain string, port int) string {
	return fmt.Sprintf(`
# Managed by hostler - %s
server {
    listen 80;
    server_name %s;

    location / {
        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
`, domain, domain, port)
}

// WriteManagedConfig writes all entries to the managed config file
func WriteManagedConfig(path string, entries []DomainEntry) error {
	var content strings.Builder
	content.WriteString("# This file is managed by hostler CLI\n")
	content.WriteString("# Do not edit manually - changes will be overwritten\n")

	for _, entry := range entries {
		content.WriteString(GenerateServerBlock(entry.Domain, entry.Port))
	}

	return os.WriteFile(path, []byte(content.String()), 0644)
}

// FindConflicts checks for domain or port conflicts in existing nginx configs
func FindConflicts(includeDir string, domain string, port int, excludeManaged bool) (domainConflict, portConflict string, err error) {
	err = filepath.Walk(includeDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".conf") {
			return nil
		}
		if excludeManaged && strings.HasSuffix(path, ManagedConfigName) {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		content := string(data)

		// Check for domain conflict
		serverNameRe := regexp.MustCompile(`server_name\s+` + regexp.QuoteMeta(domain) + `\s*;`)
		if serverNameRe.MatchString(content) {
			domainConflict = path
		}

		// Check for port conflict (only on same listen directive style)
		proxyPassRe := regexp.MustCompile(fmt.Sprintf(`proxy_pass\s+http://127\.0\.0\.1:%d;`, port))
		if proxyPassRe.MatchString(content) {
			portConflict = path
		}

		return nil
	})

	return domainConflict, portConflict, err
}

// RemoveEntry removes a domain from the entries slice
func RemoveEntry(entries []DomainEntry, domain string) []DomainEntry {
	var result []DomainEntry
	for _, e := range entries {
		if e.Domain != domain {
			result = append(result, e)
		}
	}
	return result
}

// FindEntry finds a domain in the entries slice
func FindEntry(entries []DomainEntry, domain string) *DomainEntry {
	for _, e := range entries {
		if e.Domain == domain {
			return &e
		}
	}
	return nil
}
