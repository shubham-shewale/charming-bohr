# SCM link as primary source of truth for source identity

The input CSV has separate `repository`, `file path`, and `lines` columns, but also an `scm link` column containing a full URL to the exact file at a specific commit. We chose to parse the SCM link as the single source of truth for provider detection (GitHub vs Azure DevOps), repository identity, file path, commit revision, and line numbers — rather than relying on the other columns.

This means all identity, grouping, and fetching logic derives from one parsed URL. Redundant scanner columns (`repository`, `file path`, `lines`, `title`, `severity`, `first seen`, `resource`, `policy names`) are stripped at ingestion to reduce memory overhead and eliminate output clutter, while non-redundant custom metadata columns are preserved verbatim in the output.

## Considered Options

- **Separate columns as primary**: Use `repository`, `file path`, `lines` directly. Simpler parsing but loses the commit SHA (not available in any other column), requires separate logic to detect provider (GitHub vs Azure), and the `repository` column format may not match the API's expected format.
- **SCM link as primary**: One URL contains everything — including the commit SHA, which no other column provides. Requires two URL parsers (GitHub and Azure DevOps) but gives a complete, unambiguous Canonical Source in one step.

## Consequences

- The tool must parse two URL formats (GitHub blob URLs, Azure DevOps item URLs). If a new SCM provider appears, a new parser is needed.
- Findings with unparseable SCM links are marked `skipped` rather than silently falling back to other columns, making data quality issues visible immediately.
- The commit SHA from the SCM link solves the "wrong revision" problem: the tool always fetches the exact version of the file that the scanner flagged, not HEAD.
