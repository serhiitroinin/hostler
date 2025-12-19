# hostler

A CLI tool to manage local development domains with nginx. Automatically handles `/etc/hosts` entries and nginx reverse proxy configurations.

## Features

- **Auto-detects nginx** - Finds config path, include directory, and checks if running
- **Conflict detection** - Prevents duplicate domains and port conflicts
- **Managed config** - Maintains a single config file, doesn't touch other nginx configs
- **Table output** - Lists domains with status (up/down)
- **Auto-reload** - Tests and reloads nginx configuration automatically

## Installation

### Homebrew (macOS/Linux)

```bash
brew tap serhiitroinin/tap
brew install hostler
```

### From source

```bash
git clone https://github.com/serhiitroinin/hostler.git
cd hostler
go build -o hostler .
sudo mv hostler /usr/local/bin/
```

### Prerequisites

- nginx installed and configured
- Root/sudo access (for `/etc/hosts` and nginx config)

## Usage

### Add a domain

```bash
sudo hostler add myapp.loc 3000
```

This will:

1. Check if nginx is running
2. Validate no conflicts exist
3. Add `127.0.0.1 myapp.loc` to `/etc/hosts`
4. Create nginx reverse proxy config
5. Test and reload nginx

### Remove a domain

```bash
sudo hostler remove myapp.loc
```

### List all domains

```bash
hostler list
```

Output:

```
+-------------+------+-------------------+--------+
|   DOMAIN    | PORT |        URL        | STATUS |
+-------------+------+-------------------+--------+
| myapp.loc   | 3000 | http://myapp.loc  | up     |
| api.loc     | 8080 | http://api.loc    | down   |
+-------------+------+-------------------+--------+

  Total: 2 domain(s)
  Config: /opt/homebrew/etc/nginx/servers/hostler-managed.conf
```

### Check status

```bash
hostler status
```

Output:

```
hostler status
─────────────────────────────────────
nginx:          running
nginx version:  1.25.3
nginx config:   /opt/homebrew/etc/nginx/nginx.conf
include dir:    /opt/homebrew/etc/nginx/servers
managed config: /opt/homebrew/etc/nginx/servers/hostler-managed.conf
managed file:   exists
domains:        2
config valid:   yes
```

## Configuration

hostler creates a single managed config file in your nginx include directory:

- **macOS (Apple Silicon)**: `/opt/homebrew/etc/nginx/servers/hostler-managed.conf`
- **macOS (Intel)**: `/usr/local/etc/nginx/servers/hostler-managed.conf`
- **Linux (Debian/Ubuntu)**: `/etc/nginx/sites-enabled/hostler-managed.conf`
- **Linux (CentOS/RHEL)**: `/etc/nginx/conf.d/hostler-managed.conf`

### Hosts file

Entries are added to `/etc/hosts` in a managed block:

```
# BEGIN hostler managed block
127.0.0.1	myapp.loc
127.0.0.1	api.loc
# END hostler managed block
```

## nginx Setup

Make sure your nginx.conf includes the appropriate directory. For Homebrew on macOS:

```nginx
http {
    # ... other config ...

    include servers/*;  # This should already be there
}
```

## Development

```bash
# Clone
git clone https://github.com/serhiitroinin/hostler.git
cd hostler

# Build
go build -o hostler .

# Test locally
sudo ./hostler add test.loc 4000
./hostler list
sudo ./hostler remove test.loc
```

## Releasing

Uses [GoReleaser](https://goreleaser.com/) for automated releases:

```bash
# Tag a release
git tag v1.0.0
git push origin v1.0.0

# GoReleaser will automatically build and publish via GitHub Actions
```

### Setting up Homebrew Tap

1. Create a repository called `homebrew-tap` in your GitHub account
2. Add a secret called `HOMEBREW_TAP_GITHUB_TOKEN` to the hostler repo with a PAT that has write access to the tap repo
3. GoReleaser will automatically update the formula on release

## License

MIT
