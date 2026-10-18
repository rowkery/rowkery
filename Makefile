# make dev                  run the current branch, synced to origin
# make dev feat/some-thing  check out that branch as on origin, then run it
# make dev 35               check out pull request #35, then run it
#                           (b=feat/some-thing works too)
#                           (runs as Rowkery Dev: its own data, never Rowkery's connections)
# make dmg                  build a release DMG for this Mac's chip
# make dmg universal        one DMG for Apple Silicon and Intel Macs
# make dmg-dev              Rowkery Dev: beside Rowkery, own data, no auto-update (dmg-dev universal too)
# make release              build a public release: universal DMG, signed update, latest.json
# make release publish      ...then a draft GitHub release on the releases repository
# make web                  build the new Next.js website (apps/web) and serve it on http://localhost:3000
# make docs                 build the docs site (apps/docs) and serve it on http://localhost:3001
# See scripts/dev.sh, scripts/dmg.sh and scripts/release.sh.

.PHONY: dev dmg dmg-dev release web docs

# Words after `dev` / `dmg` on the command line are arguments, not more targets.
ifneq (,$(filter dev dmg dmg-dev release,$(firstword $(MAKECMDGOALS))))
  extra := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  ifneq (,$(extra))
    b ?= $(firstword $(extra))
    $(eval $(extra):;@:)
  endif
endif

dev:
	@scripts/dev.sh $(b)

dmg:
	@scripts/dmg.sh $(b)

dmg-dev:
	@scripts/dmg.sh dev $(b)

release:
	@scripts/release.sh $(b)

web:
	@cd apps/web && npm install --no-audit --no-fund && npm run build
	@echo "Rowkery website (Next.js) on http://localhost:3000"
	@python3 -m http.server 3000 -d apps/web/out

docs:
	@cd apps/docs && npm install --no-audit --no-fund && npm run build
	@echo "Rowkery docs on http://localhost:3001"
	@python3 -m http.server 3001 -d apps/docs/out
