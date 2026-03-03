#!/usr/bin/env python3
"""
CLI tool to scrape Facebook page posts and save each post into its own folder.
Requirements: pip install facebook-scraper requests
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import requests
import facebook_scraper as fb
from facebook_scraper import exceptions as fb_exceptions
from facebook_scraper import get_posts, set_user_agent
from facebook_scraper.utils import parse_cookie_file
from requests.cookies import RequestsCookieJar, cookiejar_from_dict

# A modern desktop UA reduces Facebook's bot/legacy-browser blocks.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Safari/537.36"
)


def _install_lenient_cookie_setter() -> None:
    """Monkeypatch facebook_scraper.set_cookies to skip network validation.
    Some environments (or malformed cookies) cause a 400 on facebook.com/settings
    when validating cookies; skipping that check keeps scraping going.
    """

    def _set_cookies_no_validate(cookies):
        jar = None
        if isinstance(cookies, str):
            try:
                jar = parse_cookie_file(cookies)
            except Exception:
                jar = None
        elif isinstance(cookies, dict):
            jar = cookiejar_from_dict(cookies)
        else:
            jar = cookies
        if jar:
            fb._scraper.session.cookies.update(jar)

    fb.set_cookies = _set_cookies_no_validate


_install_lenient_cookie_setter()

# ---------- helpers ----------

def sanitize_for_fs(name: str, fallback: str, max_len: int = 80) -> str:
    """Return a safe folder/file name derived from `name` or `fallback`.
    Removes path separators and control chars, collapses whitespace, limits length.
    """
    cleaned = re.sub(r"[\\/:*?\"<>|]+", " ", name or "").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        cleaned = fallback
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rstrip()
    return cleaned


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def download_images(urls: Iterable[str], dest_dir: Path) -> List[Path]:
    saved = []
    for idx, url in enumerate(urls, start=1):
        try:
            resp = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] failed to download image {url}: {exc}", file=sys.stderr)
            continue
        ext = ".jpg"
        filename = dest_dir / f"image_{idx}{ext}"
        try:
            filename.write_bytes(resp.content)
            saved.append(filename)
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] failed to save image {filename}: {exc}", file=sys.stderr)
    return saved


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def extract_page_name(page_url: str) -> str:
    """Extract page name from a Facebook page URL or accept plain page slug."""
    # common formats: https://www.facebook.com/<page>/, https://facebook.com/<page>
    match = re.search(r"facebook\.com/([^/?#]+)", page_url)
    if match:
        return match.group(1)
    return page_url.strip().strip("/")


def load_env_file(path: Path) -> Dict[str, str]:
    """Minimal .env parser (KEY=VALUE, ignores blank lines and # comments)."""
    env: Dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip("\"'")
    return env


def load_cookies_lenient(path: Path) -> Tuple[Optional[RequestsCookieJar], List[int]]:
    """Parse a Netscape cookies.txt but skip malformed lines instead of failing."""
    bad_lines: List[int] = []
    jar = RequestsCookieJar()
    if not path.exists():
        raise FileNotFoundError(path)
    with path.open("r", encoding="utf-8") as f:
        for idx, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t") if "\t" in line else line.split()
            if len(parts) != 7 or parts[5] == "" or parts[6] == "":
                bad_lines.append(idx)
                continue
            domain, _, cookie_path, secure, expires, name, value = parts
            try:
                expires_int = None if expires == "0" else int(expires)
            except ValueError:
                bad_lines.append(idx)
                continue
            jar.set(
                name,
                value,
                domain=domain,
                path=cookie_path,
                secure=secure.lower() == "true",
                expires=expires_int,
            )
    if not jar:
        return None, bad_lines
    return jar, bad_lines


# ---------- main scraping ----------

def scrape_page(
    page_url: str,
    output_root: Path,
    max_posts: int,
    credentials: Optional[Tuple[str, str]] = None,
    cookies_path: Optional[str] = None,
) -> None:
    page_name = extract_page_name(page_url)
    if not page_name:
        raise ValueError("Could not parse page name from URL")

    page_dir = output_root / sanitize_for_fs(page_name, fallback="page")
    ensure_dir(page_dir)

    print(f"[info] scraping page '{page_name}' into {page_dir}")

    # get_posts yields ~10 posts per 'page' argument. Iterate until max_posts.
    collected = 0
    options = {
        "account": page_name,
        "pages": 50,  # upper bound; we'll stop manually after max_posts
        "extra_info": True,
    }
    if credentials:
        options["credentials"] = credentials
    if cookies_path:
        options["cookies"] = cookies_path

    for post in get_posts(**options):
        if collected >= max_posts:
            break

        post_id = str(post.get("post_id") or post.get("post_id", "unknown"))
        caption = post.get("post_text") or post.get("text") or ""
        folder_name = sanitize_for_fs(caption, fallback=f"post-{post_id}")
        post_dir = page_dir / folder_name
        # Avoid clashes if same caption repeats
        suffix = 1
        while post_dir.exists():
            post_dir = page_dir / f"{folder_name}-{suffix}"
            suffix += 1
        ensure_dir(post_dir)

        # Write caption
        write_text(post_dir / "caption.txt", caption or "")

        # Meta info
        meta_lines = [
            f"post_id: {post_id}",
            f"post_url: {post.get('post_url', '')}",
            f"time: {post.get('time', '')}",
            f"likes: {post.get('likes', 0)}",
            f"comments_total: {post.get('comments', 0)}",
            f"shares: {post.get('shares', 0)}",
        ]
        write_text(post_dir / "meta.txt", "\n".join(map(str, meta_lines)))

        # Comments
        comments = post.get("comments_full") or []
        if comments:
            comment_lines = []
            for c in comments:
                author = c.get("commenter_name") or ""
                text = c.get("comment_text") or ""
                comment_lines.append(f"{author}: {text}")
            write_text(post_dir / "comments.txt", "\n".join(comment_lines))

        # Images
        images: List[str] = []
        if post.get("images"):
            images.extend(post["images"])
        elif post.get("image"):
            images.append(post["image"])
        if images:
            saved = download_images(images, post_dir)
            if saved:
                print(f"[info] saved {len(saved)} images for post {post_id}")

        collected += 1
        print(f"[done] saved post {collected}/{max_posts}: {post_dir}")

    print(f"[complete] scraped {collected} posts into {page_dir}")


# ---------- CLI ----------

def prompt_if_missing(value: Optional[str], prompt_text: str, secret: bool = False) -> Optional[str]:
    if value:
        return value
    try:
        if secret:
            import getpass

            return getpass.getpass(prompt_text)
        return input(prompt_text)
    except EOFError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape Facebook page posts into folders")
    parser.add_argument("--page-url", help="Facebook page URL or slug (will prompt if omitted)")
    parser.add_argument("--output", default="output", help="Output root directory")
    parser.add_argument("--max-posts", type=int, default=5, help="Maximum posts to save")
    parser.add_argument("--email", help="Facebook login email (optional; improves coverage)")
    parser.add_argument("--password", help="Facebook login password (optional)")
    parser.add_argument("--cookies", help="Path to Facebook cookies txt (optional)")
    parser.add_argument("--env-file", default=".env", help="Path to .env with FACEBOOK_EMAIL/PASSWORD/COOKIES")
    parser.add_argument(
        "--user-agent",
        help="Override User-Agent sent to Facebook (defaults to a modern Chrome UA)",
    )
    parser.add_argument("--headless", action="store_true", help="Ignored placeholder for compatibility")

    args = parser.parse_args()

    env_vars = load_env_file(Path(args.env_file))

    page_url = prompt_if_missing(args.page_url, "Enter Facebook page URL or slug: ")
    if not page_url:
        print("Page URL is required", file=sys.stderr)
        sys.exit(1)

    email = args.email or env_vars.get("FACEBOOK_EMAIL")
    password = args.password or env_vars.get("FACEBOOK_PASSWORD")
    cookies_path = args.cookies or env_vars.get("FACEBOOK_COOKIES")
    user_agent = args.user_agent or env_vars.get("FACEBOOK_USER_AGENT") or DEFAULT_USER_AGENT

    # facebook-scraper keeps a global session; set UA before doing anything networky.
    if user_agent:
        set_user_agent(user_agent)
    cookies_obj: Optional[RequestsCookieJar] = None
    if cookies_path:
        try:
            cookies_obj, bad_lines = load_cookies_lenient(Path(cookies_path))
            if bad_lines:
                print(
                    f"[warn] skipped malformed cookie lines {bad_lines} in {cookies_path}; continuing with the rest",
                    file=sys.stderr,
                )
        except Exception:
            # Fall back to letting facebook-scraper parse (will error if invalid)
            cookies_obj = None

    if not email:
        email = prompt_if_missing(None, "Facebook email (leave blank for anonymous): ")
    if email and not password:
        password = prompt_if_missing(None, "Facebook password: ", secret=True)

    credentials = (email, password) if email and password else None

    # facebook-scraper rejects simultaneous cookies and credentials; prefer cookies.
    if cookies_path and credentials:
        print("[info] cookies provided; ignoring email/password because facebook-scraper accepts only one auth method", file=sys.stderr)
        credentials = None

    try:
        scrape_page(
            page_url=page_url,
            output_root=Path(args.output),
            max_posts=max(1, args.max_posts),
            credentials=credentials,
            cookies_path=cookies_obj or cookies_path,
        )
    except fb_exceptions.LoginError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        print(
            "[hint] Facebook often blocks scripted logins. Export cookies from a browser "
            "that's already signed in (Netscape format) and pass --cookies /path/to/cookies.txt.",
            file=sys.stderr,
        )
        print(
            "[hint] You can also try a different User-Agent via --user-agent or FACEBOOK_USER_AGENT.",
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
