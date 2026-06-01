# hostler

A CLI tool to manage local development domains with nginx. Automatically handles `/etc/hosts` entries and nginx reverse proxy configurations.

## Features

- **One-time setup** - Run `sudo hostler init` once, then use without sudo
- **Auto-detects nginx** - Finds config path, include directory, and checks if running
- **Conflict detection** - Prevents duplicate domains and port conflicts
- **Per-domain configs** - Each domain gets its own config file in `/etc/hostler/<user>/`
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
- Creating `/etc/hostler/<user>/` for your domain configs
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
  Created: /etc/hostler/you (root-owned)

Adding include directive to nginx.conf...
  Added: include /etc/hostler/you/*.conf;

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
3. Create `/etc/hostler/<user>/myapp.loc.conf` (via the privileged helper)
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
  Config: /etc/hostler/you
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
user config:    /etc/hostler/you
sudoers:        configured
nginx include:  configured
domains:        2

config valid:   yes
```

## Configuration

### Config directory

After initialization, hostler stores per-user domain configs under `/etc`:

```
/etc/hostler/             (root-owned)
└── <your-username>/      (root-owned)
    ├── .initialized
    ├── myapp.loc.conf
    └── api.loc.conf
```

Each domain gets its own nginx config file, making it easy to inspect and debug.

The directory is **root-owned, and deliberately not under your home**: it's
included into the root-run nginx and reloadable without a password, so letting
an unprivileged process write `.conf` files there — or rename a parent component
to swap the whole directory — would be a privilege-escalation risk. (Anything
under `~` is unsafe because you own `~` and can rename any path component.)
Instead, `add`/`remove` write configs through small privileged helpers
(`_nginx-add` / `_nginx-remove`) that re-validate the domain and port and write
hostler's own template as root.

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
- Adding/removing entries from `/etc/hosts` (`_hosts-add` / `_hosts-remove`)
- Writing per-domain nginx configs (`_nginx-add` / `_nginx-remove`)
- Running `nginx -t` and `nginx -s reload`

This is scoped to your user only and uses the minimum required privileges. Each
privileged helper re-validates its arguments, so the wildcard sudoers rules
can't be abused for arbitrary commands. `init` must be run from the compiled
binary (not `bun run`), so the sudoers rule references a stable path.

> **Upgrading from an older install?** Re-run `sudo hostler init` once. It moves
> the config directory to `/etc/hostler/<user>/` (root-owned), migrates your
> existing domains there by regenerating them from hostler's template, and
> installs the updated sudoers rules. For the strongest guarantee, install the
> `hostler` binary to a root-owned path (e.g. `/usr/local/bin`) before running
> init — otherwise it warns that the sudoers rule references a user-writable
> binary.

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
`/etc/hostler/<user>/`. Remove the stale file and reload:

```bash
sudo rm "$(nginx -V 2>&1 | grep -o -- '--conf-path=[^ ]*' | cut -d= -f2 | xargs dirname)/servers/hostler-managed.conf"
sudo nginx -s reload
```

(On Homebrew the path is usually `/opt/homebrew/etc/nginx/servers/hostler-managed.conf`.)

## License

MIT
