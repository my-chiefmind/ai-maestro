# Maestro — simple entry points. Run these from inside the kit directory.
#
#   cd ~/code/my-app
#   git clone https://github.com/spourali/maestro.git maestro && cd maestro
#   make board            # first run asks a couple of questions, then opens the console
#
.PHONY: board setup sync validate help
.DEFAULT_GOAL := help

## board: set up (first run asks questions), then open the board console
board: setup cockpit-deps
	@npm --prefix cockpit run dev

## setup: configure this project in place (idempotent — skips if already set up)
setup:
	@node bin/cli.mjs setup

## sync: re-render agents & skills after editing config.json / context.md
sync:
	@node render/sync.mjs --project . --kit .

## validate: check the board's integrity
validate:
	@node scripts/validate-board.mjs board/data.json

# Install the cockpit's dependencies only if they're missing.
.PHONY: cockpit-deps
cockpit-deps:
	@node -e "require('fs').existsSync('cockpit/node_modules/.bin/vite')||require('child_process').execSync('npm --prefix cockpit install --no-audit --no-fund',{stdio:'inherit'})"

help:
	@echo "Maestro — run these from the kit directory:"
	@echo ""
	@echo "  make board      set up (first run asks questions) and open the board UI"
	@echo "  make setup      (re)configure this project without launching"
	@echo "  make sync       re-render agents & skills after editing config.json / context.md"
	@echo "  make validate   check the board"
	@echo ""
	@echo "No 'make'? The same steps: npm run dev  (board),  node bin/cli.mjs setup  (setup)."
