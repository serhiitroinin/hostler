# hostler

A CLI tool to manage local development domains with nginx. Automatically handles `/etc/hosts` entries and nginx reverse proxy configurations.

## Features

- **One-time setup** - Run `sudo hostler init` once, then use without sudo
- **Auto-detects nginx** - Finds config path, include directory, and checks if running
- **Conflict detection** - Prevents duplicate domains and port conflicts
- **Per-domain configs** - Each domain gets its own config file in `~/.hostler/nginx/`
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
- Root/sudo access (only for initial setup)

## Quick Start

### 1. Initialize (one-time setup)

```bash
sudo hostler init
```

This sets up hostler for passwordless operation by:
- Creating `~/.hostler/nginx/` for your domain configs
- Adding an include directive to nginx.conf
- Configuring sudoers for specific operations

### 2. Add domains (no sudo needed!)

```bash
hostler add myapp.loc 3000
hostler add api.loc 8080
```

### 3. List and manage

```bash
hostler list              # Show all domains
hostler remove myapp.loc  # Remove a domain
hostler status            # Check system status
```

## Usage

### Initialize hostler

```bash
sudo hostler init
```

Output:

```
hostler init
─────────────────────────────────────
Detecting nginx...
  nginx version: 1.25.3
  nginx config: /opt/homebrew/etc/nginx/nginx.conf

Creating user configuration directory...
  Created: /Users/you/.hostler/nginx/

Adding include directive to nginx.conf...
  Added: include /Users/you/.hostler/nginx/*.conf;

Testing nginx configuration...
  nginx config is valid

Setting up passwordless sudo...
  Created: /etc/sudoers.d/hostler

Successfully initialized hostler!
```

### Add a domain

```bash
hostler add myapp.loc 3000
```

This will:

1. Check if nginx is running
2. Validate no conflicts exist
3. Create `~/.hostler/nginx/myapp.loc.conf`
4. Add `127.0.0.1 myapp.loc` to `/etc/hosts`
5. Test and reload nginx

### Remove a domain

```bash
hostler remove myapp.loc
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
  Config: /Users/you/.hostler/nginx
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

hostler mode:   initialized
user config:    /Users/you/.hostler/nginx
sudoers:        configured
nginx include:  configured
domains:        2

config valid:   yes
```

## Configuration

### User config directory

After initialization, hostler stores domain configs in your home directory:

```
~/.hostler/
└── nginx/
    ├── .initialized
    ├── myapp.loc.conf
    └── api.loc.conf
```

Each domain gets its own nginx config file, making it easy to inspect and debug.

### Hosts file

Entries are added to `/etc/hosts` in a managed block:

```
# BEGIN hostler managed block
127.0.0.1	myapp.loc
127.0.0.1	api.loc
# END hostler managed block
```

### Sudoers configuration

The `init` command creates `/etc/sudoers.d/hostler` with rules that allow:
- Adding/removing entries from `/etc/hosts`
- Running `nginx -t` and `nginx -s reload`

This is scoped to your user only and uses the minimum required privileges.

## Development

```bash
# Clone
git clone https://github.com/serhiitroinin/hostler.git
cd hostler

# Build
go build -o hostler .

# Initialize (one-time)
sudo ./hostler init

# Test locally
./hostler add test.loc 4000
./hostler list
./hostler remove test.loc
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
