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

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

```bash
git clone https://github.com/serhiitroinin/hostler.git
cd hostler
bun install
bun run build          # produces a self-contained ./hostler binary
sudo mv hostler /usr/local/bin/
```

The compiled binary is standalone — Bun is only needed to build it, not to run it.

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

Built with [Bun](https://bun.sh) + TypeScript.

```bash
# Clone
git clone https://github.com/serhiitroinin/hostler.git
cd hostler
bun install

# Run from source
bun run start -- list

# Typecheck + test (pure logic, no nginx/root required)
bun run typecheck
bun test

# Build a standalone binary
bun run build

# Initialize (one-time) and try it
sudo ./hostler init
./hostler add test.loc 4000
./hostler list
./hostler remove test.loc
```

## Releasing

Tag and push — `.github/workflows/release.yml` cross-compiles with Bun and
publishes archives + checksums to a GitHub release:

```bash
git tag v2.0.0
git push origin v2.0.0
```

`bun run build:all` cross-compiles binaries for linux/darwin on x64 and arm64
into `dist/`.

## Troubleshooting

### "conflicts" in `hostler status` / a port change does nothing

If `hostler status` reports conflicting server names, a domain is defined in
more than one nginx config and nginx silently ignores the duplicate — so
changing its port can appear to have no effect.

A common cause is a stale file from an older hostler version: the original
release wrote a single `hostler-managed.conf` into the system nginx include
directory, while the current version uses per-domain files in
`~/.hostler/nginx/`. Remove the stale file and reload:

```bash
sudo rm "$(nginx -V 2>&1 | grep -o -- '--conf-path=[^ ]*' | cut -d= -f2 | xargs dirname)/servers/hostler-managed.conf"
sudo nginx -s reload
```

(On Homebrew the path is usually `/opt/homebrew/etc/nginx/servers/hostler-managed.conf`.)

## License

MIT
