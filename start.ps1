# Manual spin-up. Not required day-to-day once the Podman machine is set to
# start automatically (see SETUP.md) — restart: unless-stopped on every
# service in docker-compose.yml means the stack comes back on its own once
# the machine is up. Use this after a fresh checkout, or after `podman
# compose down`.
podman machine start 2>$null
podman compose up -d
