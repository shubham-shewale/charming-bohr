#!/usr/bin/env python3

"""
Standalone SCM Pre-fetcher for secret-reconciler.
Downloads raw files from GitHub and Azure DevOps based on finding CSVs
and caches them using the exact Content-Identity hashing format expected by secret-reconciler.
python3 prefetch_scm_files.py input1.csv input2.csv \
  --github-pats="ghp_token1,ghp_token2,ghp_token3" \
  --azure-pat="your_azure_devops_pat" \
  --output-dir="tmp/cache" \
  --concurrency=8
Requirements: Python 3.8+ (Zero third-party pip dependencies required).
"""

import argparse
import base64
import csv
import hashlib
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION / CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

SHA_40_RE = re.compile(r"^[0-9a-fA-F]{40}$")
LINE_FRAGMENT_RE = re.compile(r"^L(\d+)(?:-L(\d+))?$")

# Common SCM link header variants
SCM_HEADER_CANDIDATES = [
    "scmlink",
    "scmlinkurl",
    "scmurl",
    "sourcelink",
    "repolink",
    "url",
    "link",
]


def normalize_header(h: str) -> str:
    return re.sub(r"[\s_]+", "", h.strip().lower())


# ─────────────────────────────────────────────────────────────────────────────
# EXACT HASHING & SCM PARSERS (Matches secret-reconciler byte-for-byte)
# ─────────────────────────────────────────────────────────────────────────────


def get_content_identity(
    provider: str,
    org: str,
    repo: str,
    revision: str,
    file_path: str,
    project: str = None,
) -> str:
    """Matches getContentIdentity in secret-reconciler/src/csv/reader.ts"""
    if project:
        repo_scope = f"{org}/{project}/{repo}"
    else:
        repo_scope = f"{org}/{repo}"
    return f"{provider}::{repo_scope}::{revision}::{file_path}"


def get_local_cache_path(
    temp_dir: str,
    provider: str,
    org: str,
    repo: str,
    revision: str,
    file_path: str,
    project: str = None,
) -> str:
    """Matches getLocalCachePath in secret-reconciler/src/fetcher/file-fetcher.ts"""
    identity = get_content_identity(
        provider, org, repo, revision, file_path, project
    )
    file_hash = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
    safe_basename = re.sub(r"[^a-zA-Z0-9._-]", "_", os.path.basename(file_path))
    return os.path.join(temp_dir, f"{file_hash}_{safe_basename}")


def parse_scm_link(raw_url: str):
    """Parses GitHub or Azure DevOps SCM URL into canonical components."""
    if not raw_url or not isinstance(raw_url, str):
        return None

    try:
        parsed = urllib.parse.urlparse(raw_url.strip())
    except Exception:
        return None

    # 1. GitHub
    if parsed.hostname == "github.com":
        segments = parsed.path.split("/")
        # /org/repo/blob/sha/path...
        if len(segments) < 5 or segments[3] != "blob":
            return None
        org = segments[1]
        repo = segments[2]
        revision = segments[4]
        if not SHA_40_RE.match(revision):
            return None

        file_path_segments = segments[5:]
        file_path = "/".join(
            urllib.parse.unquote(s) for s in file_path_segments
        )
        if not file_path:
            return None

        return {
            "provider": "github",
            "org": org,
            "project": None,
            "repo": repo,
            "revision": revision,
            "file_path": file_path,
        }

    # 2. Azure DevOps
    elif parsed.hostname == "dev.azure.com":
        segments = parsed.path.split("/")
        # /org/project/_git/repo
        if len(segments) < 5 or segments[3] != "_git":
            return None
        org = segments[1]
        project = segments[2]
        repo = segments[4]

        qs = urllib.parse.parse_qs(parsed.query)
        path_list = qs.get("path")
        if not path_list:
            return None
        raw_path = path_list[0]
        file_path = raw_path[1:] if raw_path.startswith("/") else raw_path

        version_list = qs.get("version")
        if not version_list or not version_list[0].startswith("GC"):
            return None
        revision = version_list[0][2:]
        if not SHA_40_RE.match(revision):
            return None

        return {
            "provider": "azure",
            "org": org,
            "project": project,
            "repo": repo,
            "revision": revision,
            "file_path": file_path,
        }

    return None


# ─────────────────────────────────────────────────────────────────────────────
# GITHUB TOKEN POOL & RATE LIMIT CONTROLLER
# ─────────────────────────────────────────────────────────────────────────────


class GitHubTokenPool:

    def __init__(self, tokens: list[str]):
        self.tokens = [t.strip() for t in tokens if t.strip()]
        self.lock = threading.Lock()
        self.cursor = 0
        # token -> {'remaining': int, 'reset_at': float}
        self.state = {
            t: {"remaining": 5000, "reset_at": 0.0} for t in self.tokens
        }

    def get_token(self) -> str:
        """Picks the next available token. If all exhausted, sleeps until earliest reset."""
        while True:
            with self.lock:
                now = time.time()
                # Check for any available token
                for i in range(len(self.tokens)):
                    idx = (self.cursor + i) % len(self.tokens)
                    tok = self.tokens[idx]
                    tok_state = self.state[tok]

                    # If reset time has passed, reset budget assumption
                    if now >= tok_state["reset_at"]:
                        tok_state["remaining"] = 5000

                    if tok_state["remaining"] > 5:  # Buffer of 5
                        self.cursor = (idx + 1) % len(self.tokens)
                        return tok

                # All tokens exhausted! Find earliest reset
                earliest_reset = min(s["reset_at"] for s in self.state.values())
                sleep_seconds = max(5.0, (earliest_reset - now) + 2.0)

            print(
                f"\n⚠️  [GitHub TokenPool] All {len(self.tokens)} token(s) exhausted!"
            )
            print(
                f"⏳ Sleeping for {int(sleep_seconds // 60)}m {int(sleep_seconds % 60)}s until window resets..."
            )

            # Sleep with countdown
            end_time = time.time() + sleep_seconds
            while time.time() < end_time:
                remaining = int(end_time - time.time())
                sys.stdout.write(f"\r💤 Resuming in {remaining}s...   ")
                sys.stdout.flush()
                time.sleep(min(5.0, remaining))
            print("\n🔄 Resuming downloads now...")

    def report_usage(
        self, token: str, remaining: int, reset_at: float, rate_limited=False
    ):
        with self.lock:
            if token in self.state:
                if rate_limited:
                    self.state[token]["remaining"] = 0
                    self.state[token]["reset_at"] = (
                        reset_at
                        if reset_at > 0
                        else (time.time() + 3600)
                    )
                else:
                    self.state[token]["remaining"] = remaining
                    self.state[token]["reset_at"] = reset_at


# ─────────────────────────────────────────────────────────────────────────────
# HTTP DOWNLOAD WORKERS
# ─────────────────────────────────────────────────────────────────────────────


def download_github_file(
    item: dict, token_pool: GitHubTokenPool
) -> tuple[str, bool]:
    encoded_path = "/".join(
        urllib.parse.quote(segment, safe="")
        for segment in item["file_path"].split("/")
    )
    url = f"https://api.github.com/repos/{urllib.parse.quote(item['org'], safe='')}/{urllib.parse.quote(item['repo'], safe='')}/contents/{encoded_path}?ref={urllib.parse.quote(item['revision'], safe='')}"

    while True:
        token = token_pool.get_token()
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github.raw",
                "User-Agent": "secret-reconciler-prefetch",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                rem = resp.headers.get("X-RateLimit-Remaining")
                rst = resp.headers.get("X-RateLimit-Reset")
                remaining = int(rem) if rem and rem.isdigit() else 5000
                reset_at = float(rst) if rst and rst.isdigit() else 0.0
                token_pool.report_usage(token, remaining, reset_at)
                content = resp.read().decode("utf-8", errors="replace")
                return content, True

        except urllib.error.HTTPError as e:
            rem = e.headers.get("X-RateLimit-Remaining")
            rst = e.headers.get("X-RateLimit-Reset")
            remaining = int(rem) if rem and rem.isdigit() else 0
            reset_at = (
                float(rst)
                if rst and rst.isdigit()
                else (time.time() + 3600)
            )

            if e.code in (403, 429):
                token_pool.report_usage(
                    token, 0, reset_at, rate_limited=True
                )
                continue  # Retry with next token or wait
            elif e.code == 404:
                return "", False  # File deleted or repo not accessible
            else:
                raise RuntimeError(
                    f"GitHub HTTP {e.code}: {e.reason}"
                )
        except Exception as e:
            raise RuntimeError(f"GitHub Network error: {e}")


def download_azure_file(item: dict, pat: str) -> tuple[str, bool]:
    encoded_path = urllib.parse.quote(item["file_path"], safe="")
    url = f"https://dev.azure.com/{urllib.parse.quote(item['org'], safe='')}/{urllib.parse.quote(item['project'], safe='')}/_apis/git/repositories/{urllib.parse.quote(item['repo'], safe='')}/items?path={encoded_path}&versionDescriptor.version={urllib.parse.quote(item['revision'], safe='')}&versionDescriptor.versionType=commit&api-version=7.0"

    auth_str = f":{pat}"
    b64_auth = base64.b64encode(auth_str.encode("utf-8")).decode("ascii")

    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {b64_auth}",
            "Accept": "text/plain",
            "User-Agent": "secret-reconciler-prefetch",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read().decode("utf-8", errors="replace")
            return content, True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return "", False
        elif e.code == 429:
            retry_after = int(e.headers.get("Retry-After", "10"))
            time.sleep(retry_after)
            return download_azure_file(item, pat)
        raise RuntimeError(f"Azure HTTP {e.code}: {e.reason}")
    except Exception as e:
        raise RuntimeError(f"Azure Network error: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# ATOMIC FILE WRITING
# ─────────────────────────────────────────────────────────────────────────────


def write_atomically(target_path: str, content: str):
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    temp_path = f"{target_path}.tmp.{os.getpid()}.{time.time_ns()}"
    with open(temp_path, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(temp_path, target_path)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN PIPELINE
# ─────────────────────────────────────────────────────────────────────────────


def find_scm_header(headers: list[str]) -> str | None:
    norm_map = {normalize_header(h): h for h in headers}
    for candidate in SCM_HEADER_CANDIDATES:
        if candidate in norm_map:
            return norm_map[candidate]
    return None


def parse_csv_files(csv_paths: list[str]) -> dict[str, dict]:
    """Reads all CSVs and groups distinct files by Content Identity."""
    unique_items = {}  # content_identity -> item dict

    for file_path in csv_paths:
        if not os.path.exists(file_path):
            print(f"⚠️  File not found: {file_path}")
            continue

        with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames:
                continue

            scm_col = find_scm_header(reader.fieldnames)
            if not scm_col:
                print(
                    f"⚠️  Could not find SCM link column in {os.path.basename(file_path)}"
                )
                continue

            for row in reader:
                raw_url = row.get(scm_col, "")
                parsed = parse_scm_link(raw_url)
                if parsed:
                    identity = get_content_identity(
                        parsed["provider"],
                        parsed["org"],
                        parsed["repo"],
                        parsed["revision"],
                        parsed["file_path"],
                        parsed["project"],
                    )
                    if identity not in unique_items:
                        unique_items[identity] = parsed

    return unique_items


def main():
    parser = argparse.ArgumentParser(
        description="Prefetch remote SCM files for secret-reconciler cache."
    )
    parser.add_argument(
        "csv_files", nargs="+", help="One or more finding CSV files"
    )
    parser.add_argument(
        "--output-dir",
        "-o",
        default="tmp/cache",
        help="Target cache directory (default: tmp/cache)",
    )
    parser.add_argument(
        "--github-pats",
        help="Comma-separated GitHub Personal Access Tokens (or GITHUB_PAT env)",
    )
    parser.add_argument(
        "--azure-pat",
        help="Azure DevOps Personal Access Token (or AZURE_DEVOPS_PAT env)",
    )
    parser.add_argument(
        "--concurrency",
        "-c",
        type=int,
        default=8,
        help="Concurrent download threads (default: 8)",
    )

    args = parser.parse_args()

    # Load tokens
    github_pats_raw = (
        args.github_pats
        or os.environ.get("GITHUB_PAT")
        or os.environ.get("GITHUB_PATS")
        or ""
    )
    github_pats = [p.strip() for p in github_pats_raw.split(",") if p.strip()]

    azure_pat = args.azure_pat or os.environ.get("AZURE_DEVOPS_PAT") or ""

    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    print("=" * 70)
    print("🚀 SCM BULK FILE PRE-FETCHER")
    print("=" * 70)
    print(f"📁 Target Cache Folder : {output_dir}")
    print(f"🔑 GitHub Tokens Count : {len(github_pats)}")
    print(f"🔑 Azure DevOps Token  : {'Configured' if azure_pat else 'MISSING'}")
    print(f"⚡ Concurrency Threads : {args.concurrency}")
    print("=" * 70)

    # 1. Parse CSVs
    print("\n🔍 Parsing CSV files to identify unique files...")
    items_map = parse_csv_files(args.csv_files)
    all_items = list(items_map.values())
    total_files = len(all_items)

    github_count = sum(1 for x in all_items if x["provider"] == "github")
    azure_count = sum(1 for x in all_items if x["provider"] == "azure")

    print(f"📊 Total Unique Files Found : {total_files}")
    print(f"   - GitHub Files           : {github_count}")
    print(f"   - Azure DevOps Files     : {azure_count}\n")

    if total_files == 0:
        print("No valid SCM links found in CSV(s). Exiting.")
        return

    # Check pre-existing files on disk
    pending_items = []
    already_cached = 0
    for item in all_items:
        dest_path = get_local_cache_path(
            output_dir,
            item["provider"],
            item["org"],
            item["repo"],
            item["revision"],
            item["file_path"],
            item["project"],
        )
        if os.path.exists(dest_path) and os.path.getsize(dest_path) >= 0:
            already_cached += 1
        else:
            pending_items.append(item)

    print(f"💾 Already Cached on Disk  : {already_cached}")
    print(f"📥 Remaining to Download   : {len(pending_items)}\n")

    if len(pending_items) == 0:
        print("🎉 All files are already downloaded! Nothing to do.")
        return

    token_pool = GitHubTokenPool(github_pats)

    stats = {
        "downloaded": 0,
        "failed": 0,
        "cached": already_cached,
        "processed": already_cached,
    }
    stats_lock = threading.Lock()
    start_time = time.time()

    def process_item(item):
        dest_path = get_local_cache_path(
            output_dir,
            item["provider"],
            item["org"],
            item["repo"],
            item["revision"],
            item["file_path"],
            item["project"],
        )

        try:
            if item["provider"] == "github":
                if not github_pats:
                    return False, "Missing GITHUB_PAT"
                content, ok = download_github_file(item, token_pool)
            elif item["provider"] == "azure":
                if not azure_pat:
                    return False, "Missing AZURE_DEVOPS_PAT"
                content, ok = download_azure_file(item, azure_pat)
            else:
                return False, f"Unknown provider {item['provider']}"

            if ok:
                write_atomically(dest_path, content)
                return True, None
            else:
                return False, "404 Not Found"

        except Exception as err:
            return False, str(err)

    # 2. Execute parallel downloads
    print("▶️  Starting overnight download batch...\n")
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        future_to_item = {
            executor.submit(process_item, item): item for item in pending_items
        }

        for future in as_completed(future_to_item):
            item = future_to_item[future]
            ok, err_msg = future.result()

            with stats_lock:
                stats["processed"] += 1
                if ok:
                    stats["downloaded"] += 1
                else:
                    stats["failed"] += 1

                pct = (stats["processed"] / total_files) * 100
                elapsed = time.time() - start_time
                rate = (
                    stats["downloaded"] / elapsed if elapsed > 0 else 0
                ) * 60  # files/min

                sys.stdout.write(
                    f"\r[{stats['processed']}/{total_files} | {pct:5.1f}%] "
                    f"✅ DL: {stats['downloaded']} | 💾 Cached: {stats['cached']} | ❌ Fail: {stats['failed']} "
                    f"({rate:.1f} files/min)   "
                )
                sys.stdout.flush()

    print("\n\n" + "=" * 70)
    print("🏁 BULK PRE-FETCH COMPLETED!")
    print(f"✅ Total Downloaded : {stats['downloaded']}")
    print(f"💾 Total Cached     : {stats['cached']}")
    print(f"❌ Total Failed     : {stats['failed']}")
    print(f"📁 Files saved in   : {output_dir}")
    print("=" * 70)


if __name__ == "__main__":
    main()
