.PHONY: context check
# Print live state so a fresh session starts grounded in what is true now,
# not in docs that may have drifted.
context:
	@echo "=== swing-tracker context ==="
	@echo "branch : $$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')"
	@echo "commit : $$(git log -1 --format='%h %s (%cr)' 2>/dev/null || echo '-')"
	@echo "dirty  : $$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ') uncommitted file(s)"
	@echo
	@echo "-- watchlist --"
	@awk '/^tickers:/{t=1;next} /^indices:/{t=0} t&&/^  - /{n++} END{print "tickers: " n+0}' config/watchlist.yml
	@awk '/^indices:/{i=1;next} /^[a-z]/{if(i)i=0} i&&/^  - /{n++} END{print "indices: " n+0}' config/watchlist.yml
	@awk '/^norms:/{t=1;next} /^flags:/{t=0} t&&/^  [a-z0-9_]+:/{n++} END{print "norms:   " n+0}' config/norms.yml
	@echo
	@echo "-- migrations --"
	@ls -1 supabase/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ' | sed 's/^/applied files: /'
	@echo
	@echo "-- TODO: wire these once Supabase is connected --"
	@echo "  last ingest run, row counts, failing checks, open issues"

check:
	@echo "no checks wired yet"
