# 05 — Azure DevOps support

**What to build:** Full pipeline support for Azure DevOps SCM links, so that CSVs containing Azure DevOps findings (or mixed GitHub + Azure findings) are processed correctly.

Build the Azure DevOps SCM link parser. The URL format is: `https://dev.azure.com/{org}/{project}/_git/{repo}?path={filePath}&version=GC{commitSHA}&_a=contents&line={start}&lineEnd={end}&...`. Extract: provider=azure, org, project, repo, filePath (URL-decoded), revision (strip `GC` prefix from version param), lineStart, lineEnd from query parameters.

Build the Azure DevOps `SourceProvider`: fetch file content via the Azure DevOps Items REST API with version descriptor (`versionDescriptor.version={sha}&versionDescriptor.versionType=commit`), using `AZURE_DEVOPS_PAT`.

The `SourceResolver` (or equivalent routing logic) should detect the provider from the parsed `CanonicalSource` and dispatch to the correct provider. A CSV with mixed GitHub and Azure findings should work in a single run — each finding routed to the appropriate provider for fetching.

**Blocked by:** 02 — End-to-end TruffleHog flow

**Status:** ready-for-agent

- [ ] Azure DevOps SCM link parser: extracts org, project, repo, filePath (URL-decoded), revision (GC prefix stripped), lineStart, lineEnd from query params
- [ ] Unit tests for Azure parser: valid URLs, URL-encoded paths, missing version param, missing line params, non-Azure URLs
- [ ] Azure DevOps `SourceProvider`: fetches raw file via Items REST API at specific commit, using `AZURE_DEVOPS_PAT`
- [ ] Source routing: provider detected from `CanonicalSource.provider` field, dispatches to correct provider
- [ ] Mixed-provider CSV: GitHub and Azure findings in the same input → both fetched and analyzed correctly
- [ ] Integration test: Azure DevOps findings → mocked Azure API → correct output
- [ ] Integration test: mixed CSV (GitHub + Azure) → both providers called with correct PATs
