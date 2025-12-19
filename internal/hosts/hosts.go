package hosts

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"strings"
)

const (
	beginMarker = "# BEGIN hostler managed block"
	endMarker   = "# END hostler managed block"
)

// GetHostsPath returns the path to the hosts file
func GetHostsPath() string {
	if runtime.GOOS == "windows" {
		return `C:\Windows\System32\drivers\etc\hosts`
	}
	return "/etc/hosts"
}

// HasDomain checks if a domain exists in the hosts file
func HasDomain(hostsPath, domain string) (bool, error) {
	file, err := os.Open(hostsPath)
	if err != nil {
		return false, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, domain) && !strings.HasPrefix(strings.TrimSpace(line), "#") {
			return true, nil
		}
	}
	return false, scanner.Err()
}

// AddEntry adds a domain to the hosts file in the managed block
func AddEntry(hostsPath, domain string) error {
	entries, err := getManagedEntries(hostsPath)
	if err != nil {
		return err
	}

	// Check if already exists
	for _, e := range entries {
		if e == domain {
			return nil // Already exists
		}
	}

	entries = append(entries, domain)
	return writeManagedBlock(hostsPath, entries)
}

// RemoveEntry removes a domain from the hosts file managed block
func RemoveEntry(hostsPath, domain string) error {
	entries, err := getManagedEntries(hostsPath)
	if err != nil {
		return err
	}

	var newEntries []string
	for _, e := range entries {
		if e != domain {
			newEntries = append(newEntries, e)
		}
	}

	return writeManagedBlock(hostsPath, newEntries)
}

// GetManagedDomains returns all domains in the managed block
func GetManagedDomains(hostsPath string) ([]string, error) {
	return getManagedEntries(hostsPath)
}

func getManagedEntries(hostsPath string) ([]string, error) {
	var entries []string

	file, err := os.Open(hostsPath)
	if err != nil {
		return entries, err
	}
	defer file.Close()

	inBlock := false
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()

		if strings.TrimSpace(line) == beginMarker {
			inBlock = true
			continue
		}
		if strings.TrimSpace(line) == endMarker {
			inBlock = false
			continue
		}

		if inBlock {
			// Parse "127.0.0.1	domain.loc" format
			fields := strings.Fields(line)
			if len(fields) >= 2 && fields[0] == "127.0.0.1" {
				entries = append(entries, fields[1])
			}
		}
	}

	return entries, scanner.Err()
}

func writeManagedBlock(hostsPath string, entries []string) error {
	// Read existing content
	data, err := os.ReadFile(hostsPath)
	if err != nil {
		return err
	}

	content := string(data)

	// Remove existing managed block
	var lines []string
	inBlock := false
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSpace(line) == beginMarker {
			inBlock = true
			continue
		}
		if strings.TrimSpace(line) == endMarker {
			inBlock = false
			continue
		}
		if !inBlock {
			lines = append(lines, line)
		}
	}

	// Build new managed block
	var newBlock strings.Builder
	if len(entries) > 0 {
		newBlock.WriteString(beginMarker + "\n")
		for _, domain := range entries {
			newBlock.WriteString(fmt.Sprintf("127.0.0.1\t%s\n", domain))
		}
		newBlock.WriteString(endMarker + "\n")
	}

	// Combine and write
	result := strings.Join(lines, "\n")
	// Remove trailing newlines
	result = strings.TrimRight(result, "\n")
	// Add our block at the end
	if len(entries) > 0 {
		result = result + "\n" + newBlock.String()
	} else {
		result = result + "\n"
	}

	return os.WriteFile(hostsPath, []byte(result), 0644)
}
